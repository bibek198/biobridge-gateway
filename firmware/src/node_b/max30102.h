// Register-level MAX30102 driver (no third-party library), configured for red+IR at 100 samples/s.
// Datasheet: Maxim MAX30102, "High-Sensitivity Pulse Oximeter and Heart-Rate Sensor".
#pragma once

#include <Wire.h>
#include <stdint.h>

class Max30102 {
 public:
  static constexpr uint8_t I2C_ADDR = 0x57;
  static constexpr uint8_t PART_ID = 0x15;
  static constexpr uint8_t FIFO_DEPTH = 32;

  struct Sample {
    uint32_t red;  // 18-bit
    uint32_t ir;   // 18-bit
  };

  /** Resets and configures the sensor. Returns false if it does not answer with the expected part ID. */
  bool begin(TwoWire &wire, uint8_t led_current = 0x24);

  /** Reads and clears the interrupt status registers (releases the INT pin). */
  uint8_t clearInterrupts();

  /**
   * Drains up to max samples from the FIFO, oldest first. Returns how many were read.
   * *overflowed is set to the number of samples the FIFO dropped since the last read.
   */
  uint8_t readFifo(Sample *out, uint8_t max, uint8_t *overflowed);

 private:
  TwoWire *wire_ = nullptr;
  bool write(uint8_t reg, uint8_t value);
  bool read(uint8_t reg, uint8_t *dst, size_t n);
};
