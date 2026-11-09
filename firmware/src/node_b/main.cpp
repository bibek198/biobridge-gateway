// BioBridge Node B: MAX30102 red/IR PPG at 100 Hz -> BioBridge frames over BLE notifications.
//
// Sampling: the MAX30102 paces itself (its own oscillator) and pulls INT low on every new sample.
// The INT ISR timestamps the edge with esp_timer; the PPG task drains the FIFO and assigns that
// timestamp to the newest sample (older ones are period-spaced back from it). Samples are batched so
// that one frame fits one notification at the negotiated ATT MTU (up to 5 samples = 50 ms).
//
// Compute placement (common/placement.h): in EDGE/GATED/BOTH modes the PPG task also runs the bbdsp PPG
// pipeline (pulse rate, SpO2, signal quality) and sends DERIVED frames. GATED sends samples only while
// the signal quality index is below 0.8 (motion, poor contact). The host writes CONFIG frames to a
// second characteristic (DATA_CHAR + 1).
//
// The USB serial port carries human-readable logs only. SENSOR_SIM=1 synthesises PPG on the board.

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Wire.h>
#include <esp_timer.h>
#include <math.h>

#include "bbframe.h"
#include "bbdsp.h"
#include "common/frame_out.h"
#include "common/placement.h"
#include "common/sync_input.h"
#include "max30102.h"

#ifndef I2C_SDA_GPIO
#define I2C_SDA_GPIO 21
#endif
#ifndef I2C_SCL_GPIO
#define I2C_SCL_GPIO 22
#endif
#ifndef MAX_INT_GPIO
#define MAX_INT_GPIO 19
#endif
#ifndef SYNC_GPIO
#define SYNC_GPIO 4
#endif
#ifndef SENSOR_SIM
#define SENSOR_SIM 0
#endif

// Must match app/src/descriptors/library/biobridge-node-b.json.
static const char *SERVICE_UUID = "6b1e0001-b19b-4b1d-9e0a-0b1b2d3c4e5f";
static const char *DATA_CHAR_UUID = "6b1e0002-b19b-4b1d-9e0a-0b1b2d3c4e5f";
static const char *COMMAND_CHAR_UUID = "6b1e0003-b19b-4b1d-9e0a-0b1b2d3c4e5f";
static const char *DEVICE_NAME = "BioBridge-B";

static const uint32_t SAMPLE_RATE_HZ = 100;
static const uint32_t PERIOD_US = 1000000 / SAMPLE_RATE_HZ;
static const uint8_t MAX_BATCH = 5;
static const uint8_t SAMPLE_BYTES = 6;  // red u24 + ir u24

static NimBLECharacteristic *s_data_char = nullptr;
static volatile bool s_subscribed = false;
static volatile bool s_send_hello = false;
static volatile uint16_t s_mtu = 23;

static TaskHandle_t s_ppg_task = nullptr;
static volatile uint32_t s_tick_ts_us = 0;

static void IRAM_ATTR on_sample_ready() {
  s_tick_ts_us = (uint32_t)esp_timer_get_time();
  BaseType_t woken = pdFALSE;
  vTaskNotifyGiveFromISR(s_ppg_task, &woken);
  if (woken) portYIELD_FROM_ISR();
}

// ---- BLE ----------------------------------------------------------------------------------------

static bool ble_sink(const uint8_t *frame, size_t len) {
  if (!s_subscribed || len + 3 > s_mtu) return false;
  s_data_char->setValue(frame, len);
  s_data_char->notify();
  return true;
}

/** Samples per frame so that header + payload + CRC fits one notification (ATT MTU - 3). */
static uint8_t samples_per_frame() {
  int room = (int)s_mtu - 3 - BB_OVERHEAD - 3;  // 3 = count u8 + period u16
  int n = room / SAMPLE_BYTES;
  return (uint8_t)(n < 0 ? 0 : (n > MAX_BATCH ? MAX_BATCH : n));
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *server, ble_gap_conn_desc *desc) override {
    // Ask for a 7.5-15 ms connection interval: lower latency and jitter for the sync experiments.
    server->updateConnParams(desc->conn_handle, 6, 12, 0, 400);
    Serial.println("BLE: connected");
  }
  void onDisconnect(NimBLEServer *) override {
    s_subscribed = false;
    s_mtu = 23;
    Serial.println("BLE: disconnected, advertising again");
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc *) override {
    s_mtu = mtu;
    Serial.printf("BLE: MTU %u -> %u samples/frame\n", mtu, samples_per_frame());
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c) override {
    // One command frame per write; decode it like any byte stream.
    static bb_decoder_t rx;
    bb_decoder_init(&rx);
    NimBLEAttValue v = c->getValue();
    bb_frame_t f;
    for (size_t i = 0; i < v.length(); i++) {
      if (bb_decoder_push(&rx, v.data()[i], &f)) placement_on_frame(f);
    }
  }
};

class DataCallbacks : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *, ble_gap_conn_desc *, uint16_t sub_value) override {
    s_subscribed = (sub_value & 0x0001) != 0;
    if (s_subscribed) s_send_hello = true;
  }
};

static void ble_begin() {
  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setPower(ESP_PWR_LVL_P6);
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  NimBLEService *service = server->createService(SERVICE_UUID);
  s_data_char = service->createCharacteristic(DATA_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY);
  s_data_char->setCallbacks(new DataCallbacks());
  NimBLECharacteristic *cmd = service->createCharacteristic(COMMAND_CHAR_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  cmd->setCallbacks(new CommandCallbacks());
  service->start();

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);  // 128-bit UUID + name do not fit one advertising packet; name goes in the scan response
  adv->start();
}

// ---- sample source --------------------------------------------------------------------------------

static Max30102 s_sensor;

#if SENSOR_SIM
static hw_timer_t *s_timer = nullptr;

static float gaussian(float x, float c, float w, float h) { return h * expf(-((x - c) * (x - c)) / (2 * w * w)); }

static uint8_t read_samples(Max30102::Sample *out, uint8_t max, uint8_t *overflowed, uint32_t ts_us) {
  (void)max;
  *overflowed = 0;
  const float beat_us = 60e6f / 72.0f;
  float x = fmodf((float)ts_us, beat_us) / beat_us;
  float pulse = gaussian(x, 0.13f, 0.05f, 1) + gaussian(x, 0.38f, 0.07f, 0.4f) + gaussian(x - 1, 0.13f, 0.05f, 1);
  out[0].ir = (uint32_t)(120000.0f * (1 - 0.02f * pulse)) + esp_random() % 40;
  out[0].red = (uint32_t)(90000.0f * (1 - 0.01f * pulse)) + esp_random() % 40;
  return 1;
}

static bool source_begin() {
  s_timer = timerBegin(0, 80, true);  // 1 MHz
  timerAttachInterrupt(s_timer, &on_sample_ready, true);
  timerAlarmWrite(s_timer, PERIOD_US, true);
  timerAlarmEnable(s_timer);
  return true;
}
#else
static uint8_t read_samples(Max30102::Sample *out, uint8_t max, uint8_t *overflowed, uint32_t) {
  s_sensor.clearInterrupts();
  return s_sensor.readFifo(out, max, overflowed);
}

static bool source_begin() {
  Wire.begin(I2C_SDA_GPIO, I2C_SCL_GPIO, 400000);
  if (!s_sensor.begin(Wire)) return false;
  pinMode(MAX_INT_GPIO, INPUT_PULLUP);  // INT is open-drain, active low
  attachInterrupt(digitalPinToInterrupt(MAX_INT_GPIO), on_sample_ready, FALLING);
  return true;
}
#endif

// ---- batching -----------------------------------------------------------------------------------

static void ppg_task(void *) {
  Max30102::Sample fifo[Max30102::FIFO_DEPTH];
  Max30102::Sample batch[MAX_BATCH];
  uint8_t count = 0;
  uint32_t batch_ts = 0;
  uint8_t payload[3 + SAMPLE_BYTES * MAX_BATCH];
  static bbdsp_ppg_t dsp;  // ~1.5 KB: keep it off the task stack
  bbdsp_ppg_init(&dsp, (float)SAMPLE_RATE_HZ);
  bbdsp_event_t events[BBDSP_MAX_EVENTS_PER_PUSH];
  float last_sqi = -1.f;

  auto flush = [&]() {
    if (count == 0) return;
    // GATED: samples only while signal quality is low (or not yet known).
    if (!placement_sends_samples(last_sqi < 0.8f)) {
      count = 0;
      return;
    }
    bb_writer_t w;
    bb_w_init(&w, payload, sizeof payload);
    bb_w_u8(&w, count);
    bb_w_u16(&w, (uint16_t)PERIOD_US);
    for (uint8_t i = 0; i < count; i++) {
      bb_w_u24(&w, batch[i].red);
      bb_w_u24(&w, batch[i].ir);
    }
    if (s_subscribed) frame_out_send(BB_SAMPLES, batch_ts, payload, (uint8_t)w.len);
    count = 0;
  };

  for (;;) {
    // Time out so a missing INT (sensor unplugged, FIFO stalled) still drains whatever is there.
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(50));
    uint32_t newest_ts = s_tick_ts_us;
    uint8_t overflowed = 0;
    uint8_t n = read_samples(fifo, Max30102::FIFO_DEPTH, &overflowed, newest_ts);
    if (n == 0) continue;
    if (overflowed > 0) flush();  // samples were lost: don't let timestamps run across the gap

    uint8_t per_frame = samples_per_frame();
    for (uint8_t i = 0; i < n; i++) {
      uint32_t ts = newest_ts - (uint32_t)(n - 1 - i) * PERIOD_US;
      // A sample that is not where the batch's period-spacing predicts starts a new batch.
      if (count > 0 && (int32_t)(ts - (batch_ts + count * PERIOD_US)) > (int32_t)(PERIOD_US / 2)) flush();
      if (count == 0) batch_ts = ts;
      batch[count++] = fifo[i];
      if (placement_runs_dsp() && s_subscribed) {
        int64_t t0 = esp_timer_get_time();
        int ne = bbdsp_ppg_push(&dsp, (float)fifo[i].red, (float)fifo[i].ir, ts, events);
        placement_add_dsp_us((uint32_t)(esp_timer_get_time() - t0));
        for (int k = 0; k < ne; k++) {
          if (events[k].kind == BBDSP_SQI) last_sqi = events[k].value;
          placement_send_event(events[k]);
        }
      }
      if (per_frame == 0) count = 0;  // MTU too small to send anything yet
      else if (count >= per_frame) flush();
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.printf("BioBridge Node B%s\n", SENSOR_SIM ? " (SENSOR_SIM)" : "");

  frame_out_begin(ble_sink);
  placement_begin(BB_MODE_RAW);
  ble_begin();
  sync_input_begin(SYNC_GPIO);

  xTaskCreatePinnedToCore(ppg_task, "ppg", 6144, nullptr, configMAX_PRIORITIES - 2, &s_ppg_task, 1);
  if (!source_begin()) {
    Serial.println("MAX30102 not found on I2C (check SDA/SCL/power). Retrying every 2 s.");
    while (!source_begin()) delay(2000);
  }
  Serial.println("Sampling at 100 Hz; advertising as BioBridge-B");
}

void loop() {
  static uint32_t last_hello_ms = 0;
  uint32_t now_ms = millis();
  if (s_subscribed && (s_send_hello || now_ms - last_hello_ms >= 5000)) {
    s_send_hello = false;
    last_hello_ms = now_ms;
    frame_out_hello(BB_NODE_B_PPG, SAMPLE_RATE_HZ);
  }
  // Timing probes at random 100-300 ms intervals. Sample frames leave every 50 ms, which is commensurate
  // with typical connection intervals, so on their own they only ever see a few phases of the
  // connection-event grid; probes at random phases let the host find the true delay floor.
#if TIME_PROBES
  static uint32_t next_probe_ms = 0;
  if (s_subscribed && (int32_t)(now_ms - next_probe_ms) >= 0) {
    frame_out_probe();
    next_probe_ms = now_ms + 100 + esp_random() % 200;
  }
#endif

  if (s_subscribed) placement_tick(now_ms);
  sync_input_drain();
  delay(1);
}
