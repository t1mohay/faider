/*
 * Тестовая прошивка физического фейдера для fader-server.
 *
 * Что делает:
 *   - читает потенциометр фейдера и шлёт MIDI Control Change (номер CC = номер фейдера, значение 0..127);
 *   - принимает CC с сервера (фейдер подвинули в интерфейсе) и «двигает мотор» — пока вместо мотора
 *     яркость светодиода (ШИМ), место для настоящего драйвера мотора помечено ниже;
 *   - необязательно: датчик касания (или просто кнопка) — Note On при касании, Note Off при отпускании.
 *
 * Режим связи — дефайн USB_MIDI ниже:
 *   0 — MIDI-байты через Serial (COM-порт). Arduino Uno / Nano / Mega, обычный ESP32 (WROOM, DevKit).
 *       В интерфейсе выбирать устройство из группы «COM-порт».
 *   1 — плата сама становится USB-MIDI устройством.
 *       Arduino Leonardo / Micro / Pro Micro — нужна библиотека MIDIUSB (Library Manager → «MIDIUSB»).
 *       ESP32-S2 / ESP32-S3 — ядро esp32 версии 3.x, в Tools → USB Mode выбрать «USB-OTG (TinyUSB)».
 *       В интерфейсе выбирать устройство из группы «USB-MIDI».
 */

#define USB_MIDI 0

// ---------- Настройки ----------
const uint8_t MIDI_CHANNEL = 1;     // 1..16, как MIDI_CHANNEL на сервере
const uint8_t FADER_ID = 1;         // номер фейдера в интерфейсе = номер CC и ноты касания
const long SERIAL_BAUD = 115200;    // как HW_BAUD на сервере (только для USB_MIDI 0)

#if defined(ESP32)
const int POT_PIN = A0;             // ESP32: GPIO36, ESP32-S3: GPIO1 — проверьте распиновку своей платы
const int LED_PIN = 2;              // «мотор»: светодиод с ШИМ
const int ADC_MAX = 4095;           // 12-битный АЦП
#else
const int POT_PIN = A0;
const int LED_PIN = 9;              // Uno/Nano/Leonardo: ножка с ШИМ (~)
const int ADC_MAX = 1023;           // 10-битный АЦП
#endif

const int TOUCH_PIN = -1;           // кнопка/датчик касания на землю (INPUT_PULLUP); -1 — нет датчика
const unsigned long MOTOR_TIMEOUT_MS = 1000;  // дольше мотор не едет — считаем, что приехал/застрял
const int MOTOR_TOLERANCE = 1;      // «доехал», если отличается от цели не больше чем на столько

// ---------- Транспорт: отправка и приём MIDI ----------
#if USB_MIDI && defined(ESP32)
#include "soc/soc_caps.h"
#if !SOC_USB_OTG_SUPPORTED
#error "Обычный ESP32 не умеет быть USB-MIDI: поставьте USB_MIDI 0 (COM-порт) или возьмите ESP32-S2/S3"
#endif
#elif USB_MIDI && !defined(USBCON)
#error "Эта плата (Uno/Nano/Mega) не умеет быть USB-MIDI: поставьте USB_MIDI 0 (COM-порт)"
#endif

#if USB_MIDI && defined(ESP32)
#include "USB.h"
#include "USBMIDI.h"
USBMIDI usbMidi;
#elif USB_MIDI
#include <MIDIUSB.h>
#endif

void transportBegin() {
#if USB_MIDI && defined(ESP32)
  usbMidi.begin();
  USB.begin();
#elif !USB_MIDI
  Serial.begin(SERIAL_BAUD);
#endif
}

/** Отправить 3-байтовое MIDI-сообщение (status, data1, data2). */
void midiSend(uint8_t status, uint8_t d1, uint8_t d2) {
#if USB_MIDI && defined(ESP32)
  midiEventPacket_t p = {(uint8_t)(status >> 4), status, d1, d2};
  usbMidi.writePacket(&p);
#elif USB_MIDI
  midiEventPacket_t p = {(uint8_t)(status >> 4), status, d1, d2};
  MidiUSB.sendMIDI(p);
  MidiUSB.flush();
#else
  uint8_t msg[3] = {status, d1, d2};
  Serial.write(msg, 3);
#endif
}

void onControlChange(uint8_t channel, uint8_t controller, uint8_t value);

#if !USB_MIDI
// Разбор потока из Serial: байты приходят по одному, поддерживаем running status.
uint8_t rxStatus = 0, rxData[2], rxCount = 0;

void serialMidiByte(uint8_t b) {
  if (b >= 0xF8) return;               // realtime — пропускаем
  if (b & 0x80) {                      // статус
    rxStatus = (b < 0xF0) ? b : 0;     // system common нам не нужен
    rxCount = 0;
    return;
  }
  if (!rxStatus) return;
  rxData[rxCount++] = b;
  uint8_t need = ((rxStatus & 0xF0) == 0xC0 || (rxStatus & 0xF0) == 0xD0) ? 1 : 2;
  if (rxCount < need) return;
  rxCount = 0;
  if ((rxStatus & 0xF0) == 0xB0) onControlChange((rxStatus & 0x0F) + 1, rxData[0], rxData[1]);
}
#endif

void transportPoll() {
#if USB_MIDI && defined(ESP32)
  midiEventPacket_t p;
  while (usbMidi.readPacket(&p)) {
    if ((p.byte1 & 0xF0) == 0xB0) onControlChange((p.byte1 & 0x0F) + 1, p.byte2, p.byte3);
  }
#elif USB_MIDI
  for (midiEventPacket_t p = MidiUSB.read(); p.header != 0; p = MidiUSB.read()) {
    if ((p.byte1 & 0xF0) == 0xB0) onControlChange((p.byte1 & 0x0F) + 1, p.byte2, p.byte3);
  }
#else
  while (Serial.available() > 0) serialMidiByte(Serial.read());
#endif
}

// ---------- Фейдер ----------
float smoothed = 0;          // сглаженное показание АЦП
int lastSent = -1;           // последнее отправленное значение 0..127
bool touched = false;

bool motorActive = false;    // мотор едет к цели — в это время свои движения не шлём (иначе эхо)
int motorTarget = 0;
unsigned long motorStarted = 0;

int readFader() {
  return (int)(smoothed * 127.0 / ADC_MAX + 0.5);
}

/** Сюда подключить драйвер мотора. Сейчас — светодиод: яркость = положение цели. */
void motorDrive(int target) {
  analogWrite(LED_PIN, map(target, 0, 127, 0, 255));
  // Настоящий мотор: ехать в сторону target, пока readFader() != target (с ПИД или хотя бы с замедлением у цели).
}

void motorStop() {
  // Настоящий мотор: снять питание с драйвера.
}

void onControlChange(uint8_t channel, uint8_t controller, uint8_t value) {
  if (channel != MIDI_CHANNEL || controller != FADER_ID) return;
  if (touched) return;       // фейдер держат рукой — рука главнее, мотор не борется с пальцем
  motorTarget = value;
  motorActive = true;
  motorStarted = millis();
  motorDrive(motorTarget);
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  if (TOUCH_PIN >= 0) pinMode(TOUCH_PIN, INPUT_PULLUP);
  transportBegin();
  smoothed = analogRead(POT_PIN);
}

void loop() {
  transportPoll();

  // касание: Note On / Note Off, нота = номер фейдера
  if (TOUCH_PIN >= 0) {
    bool now = digitalRead(TOUCH_PIN) == LOW;
    if (now != touched) {
      touched = now;
      if (touched) {
        motorActive = false; // рука взяла фейдер — мотор отпускает
        motorStop();
        midiSend(0x90 | (MIDI_CHANNEL - 1), FADER_ID, 127);
      } else {
        midiSend(0x80 | (MIDI_CHANNEL - 1), FADER_ID, 0);
      }
    }
  }

  // сглаживание, чтобы значение не прыгало между соседними числами от шума АЦП
  smoothed += (analogRead(POT_PIN) - smoothed) * 0.2;
  int value = readFader();

  if (motorActive) {
    bool arrived = abs(value - motorTarget) <= MOTOR_TOLERANCE;
    if (arrived || millis() - motorStarted > MOTOR_TIMEOUT_MS) {
      motorActive = false;
      motorStop();
      lastSent = value;      // новая точка отсчёта: положение после мотора — не движение рукой
    }
    delay(2);
    return;
  }

  // гистерезис: отправляем, только если ушли от последнего значения больше чем на 0.7 шага
  float step = (float)ADC_MAX / 127.0;
  if (lastSent < 0 || (value != lastSent && fabs(smoothed - lastSent * step) > step * 0.7)) {
    lastSent = value;
    midiSend(0xB0 | (MIDI_CHANNEL - 1), FADER_ID, value);
  }
  delay(2);
}
