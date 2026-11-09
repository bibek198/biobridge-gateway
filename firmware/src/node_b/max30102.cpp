#include "max30102.h"

#include <Arduino.h>

namespace reg {
constexpr uint8_t INT_STATUS_1 = 0x00;
constexpr uint8_t INT_STATUS_2 = 0x01;
constexpr uint8_t INT_ENABLE_1 = 0x02;
constexpr uint8_t INT_ENABLE_2 = 0x03;
constexpr uint8_t FIFO_WR_PTR = 0x04;
constexpr uint8_t OVF_COUNTER = 0x05;
constexpr uint8_t FIFO_RD_PTR = 0x06;
constexpr uint8_t FIFO_DATA = 0x07;
constexpr uint8_t FIFO_CONFIG = 0x08;
constexpr uint8_t MODE_CONFIG = 0x09;
constexpr uint8_t SPO2_CONFIG = 0x0A;
constexpr uint8_t LED1_PA = 0x0C;  // red
constexpr uint8_t LED2_PA = 0x0D;  // IR
constexpr uint8_t PART_ID = 0xFF;
}  // namespace reg

bool Max30102::write(uint8_t r, uint8_t value) {
  wire_->beginTransmission(I2C_ADDR);
  wire_->write(r);
  wire_->write(value);
  return wire_->endTransmission() == 0;
}

bool Max30102::read(uint8_t r, uint8_t *dst, size_t n) {
  wire_->beginTransmission(I2C_ADDR);
  wire_->write(r);
  if (wire_->endTransmission(false) != 0) return false;
  if (wire_->requestFrom((uint8_t)I2C_ADDR, (uint8_t)n) != n) return false;
  for (size_t i = 0; i < n; i++) dst[i] = (uint8_t)wire_->read();
  return true;
}

bool Max30102::begin(TwoWire &wire, uint8_t led_current) {
  wire_ = &wire;
  uint8_t id = 0;
  if (!read(reg::PART_ID, &id, 1) || id != PART_ID) return false;

  // Soft reset (MODE_CONFIG bit 6); the bit self-clears when done.
  write(reg::MODE_CONFIG, 0x40);
  for (int i = 0; i < 100; i++) {
    uint8_t mode = 0x40;
    read(reg::MODE_CONFIG, &mode, 1);
    if (!(mode & 0x40)) break;
    delay(1);
  }

  // FIFO: no sample averaging (we want every 100 Hz sample), rollover on so a stall drops old data
  // (counted by OVF_COUNTER) instead of freezing.
  write(reg::FIFO_CONFIG, 0x10);  // SMP_AVE=000, FIFO_ROLLOVER_EN=1, FIFO_A_FULL=0000
  // SpO2 config: ADC range 4096 nA (01), 100 sps (001), 411 µs pulse = 18-bit resolution (11).
  write(reg::SPO2_CONFIG, 0x27);  // 0 | ADC_RGE=01 | SR=001 | LED_PW=11
  write(reg::LED1_PA, led_current);
  write(reg::LED2_PA, led_current);
  // Interrupt on every new sample (PPG_RDY) so the INT edge timestamps the newest sample.
  write(reg::INT_ENABLE_1, 0x40);
  write(reg::INT_ENABLE_2, 0x00);
  write(reg::FIFO_WR_PTR, 0);
  write(reg::OVF_COUNTER, 0);
  write(reg::FIFO_RD_PTR, 0);
  // SpO2 mode: red + IR LEDs active. Start last so the FIFO begins empty.
  write(reg::MODE_CONFIG, 0x03);
  clearInterrupts();
  return true;
}

uint8_t Max30102::clearInterrupts() {
  uint8_t s[2] = {0, 0};
  read(reg::INT_STATUS_1, s, 2);
  return s[0];
}

uint8_t Max30102::readFifo(Sample *out, uint8_t max, uint8_t *overflowed) {
  uint8_t ptrs[3];  // WR_PTR, OVF_COUNTER, RD_PTR are consecutive registers
  if (!read(reg::FIFO_WR_PTR, ptrs, 3)) return 0;
  *overflowed = ptrs[1] & 0x1F;
  uint8_t available = (uint8_t)((ptrs[0] - ptrs[2]) & 0x1F);
  if (available == 0 && *overflowed > 0) available = FIFO_DEPTH;  // full
  if (available > max) available = max;

  for (uint8_t i = 0; i < available; i++) {
    uint8_t b[6];  // red (3 bytes, MSB first) then IR (3 bytes)
    if (!read(reg::FIFO_DATA, b, 6)) return i;
    out[i].red = (((uint32_t)b[0] << 16) | ((uint32_t)b[1] << 8) | b[2]) & 0x3FFFF;
    out[i].ir = (((uint32_t)b[3] << 16) | ((uint32_t)b[4] << 8) | b[5]) & 0x3FFFF;
  }
  return available;
}
