/* Smart_Green 2.0 - CPS conectado e resiliente.
   Cada amostra permanece na RAM ate o ACK do Node-RED.
   Broker publico: dados simulados. Buffer volatil limitado a 30 amostras. */
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHTesp.h>
#include <ESP32Servo.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <math.h>

const char* BASE = "scc/grupo_smartgreen_a8d747d1";
const char* BROKER = "broker.emqx.io";
const uint16_t BROKER_PORT = 1883;
const char* DEVICE = "smartgreen-esp32-01";
String topicTelemetry,topicCommand,topicStatus,topicAck,bootId,clientId;
const int PIN_SOIL=34,PIN_DHT=18,PIN_BUTTON=19,PIN_NET=23;
const int PIN_SERVO=13,PIN_LED_GREEN=26,PIN_LED_RED=27;
const unsigned long SAMPLE_MS=3000,LCD_MS=200,RETRY_MS=4000,ACK_RETRY_MS=1500;
const uint8_t MAX_BUFFER=30;
struct Sample {
  uint32_t seq; uint64_t uptime;
  float soil,temp,humid;
  bool valve,automatic,sensorValid,replay;
  uint8_t setpoint;
};
Sample queueSamples[MAX_BUFFER];
uint8_t head=0,count=0;
uint32_t lost=0,sequence=0,retries=0;
unsigned long lastSample=0,lastLCD=0,lastConnect=0,lastTx=0;
unsigned long buttonChanged=0;
bool rawButton=HIGH,stableButton=HIGH;
bool valve=false,automatic=true,netBlocked=false,waitingAck=false;
uint8_t setpoint=40;
float lastSoil=0,lastTemp=NAN,lastHumid=NAN;
bool sensorValid=false;
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
DHTesp dht;
Servo servoValve;
LiquidCrystal_I2C lcd(0x27,16,2);
uint64_t uptimeMs(){return esp_timer_get_time()/1000ULL;}
bool connected(){return !netBlocked&&WiFi.status()==WL_CONNECTED&&mqtt.connected();}
void printRow(int row,const String &value){
 lcd.setCursor(0,row);String out=value.substring(0,16);while(out.length()<16)out+=' ';lcd.print(out);
}
void setValve(bool open){valve=open;servoValve.write(open?90:0);}
void updateIHM(){
 const bool online=connected();
 digitalWrite(PIN_LED_GREEN,online?HIGH:LOW);digitalWrite(PIN_LED_RED,online?LOW:HIGH);
 String temperature=sensorValid?String(lastTemp,0):String("--");
 // A valvula permanece visivel; LCD HD44780 usa caracteres ASCII.
 printRow(0,"S"+String(lastSoil,0)+"% T"+temperature+"C V:"+(valve?"A":"F"));
 printRow(1,String(online?"MQTT:Online":"MQTT:Offline")+" B"+String(count));
}
void pushSample(const Sample &s){
 if(count==MAX_BUFFER){
   Serial.printf("[DESCARTE] seq=%lu motivo=capacidade\n",(unsigned long)queueSamples[head].seq);
   head=(head+1)%MAX_BUFFER;count--;lost++;waitingAck=false;
 }
 queueSamples[(head+count)%MAX_BUFFER]=s;count++;
}
void fillSample(JsonDocument &d,const Sample &s){
 d["schema"]=2;d["device"]=DEVICE;d["boot_id"]=bootId;d["seq"]=s.seq;
 d["uptime_ms"]=s.uptime;d["soil_pct"]=s.soil;
 if(s.sensorValid){d["temp_c"]=s.temp;d["air_humidity_pct"]=s.humid;}
 else{d["temp_c"]=nullptr;d["air_humidity_pct"]=nullptr;}
 d["sensor_valid"]=s.sensorValid;d["valve_open"]=s.valve;d["auto"]=s.automatic;d["setpoint"]=s.setpoint;
}
void onMessage(char* topic,byte* payload,unsigned int len){
 if(len==0||len>400)return;
 JsonDocument d;if(deserializeJson(d,payload,len))return;
 if(String(topic)==topicAck){
   if(d["schema"].as<int>()!=2||!d["device"].is<const char*>()||!d["boot_id"].is<const char*>()||!d["seq"].is<uint32_t>())return;
   if(String(d["device"].as<const char*>())!=DEVICE||String(d["boot_id"].as<const char*>())!=bootId||!count)return;
   if(d["seq"].as<uint32_t>()!=queueSamples[head].seq)return;
   // Unico ponto de retirada normal: confirmacao da amostra armazenada no Node-RED.
   Serial.printf("[ACK] seq=%lu pendentes=%u\n",(unsigned long)queueSamples[head].seq,(unsigned)(count-1));
   head=(head+1)%MAX_BUFFER;count--;waitingAck=false;return;
 }
 if(String(topic)!=topicCommand)return;
 if(d["auto"].is<bool>())automatic=d["auto"].as<bool>();
 if(d["setpoint"].is<int>()){int v=d["setpoint"].as<int>();if(v>=10&&v<=90)setpoint=v;}
 if(!automatic&&d["valve"].is<bool>())setValve(d["valve"].as<bool>());
 updateIHM();
 Serial.printf("[COMANDO] auto=%d valvula=%d alvo=%u\n",automatic,valve,setpoint);
}
void flushBuffer(){
 if(!connected()||!count)return;
 unsigned long now=millis();
 if(waitingAck&&now-lastTx<ACK_RETRY_MS)return;
 Sample &s=queueSamples[head];
 if(waitingAck){retries++;s.replay=true;}
 JsonDocument d;fillSample(d,s);d["sent_uptime_ms"]=uptimeMs();
 d["replay"]=s.replay;d["buffer_count"]=count-1;d["dropped"]=lost;d["retries"]=retries;
 char out[640];size_t n=serializeJson(d,out,sizeof(out));
 if(n>=sizeof(out)-1)return;
 if(mqtt.publish(topicTelemetry.c_str(),out)){
   lastTx=now;waitingAck=true;
   Serial.printf("[ENVIO] seq=%lu replay=%d pendentes=%u aguardando_ACK=1\n",(unsigned long)s.seq,s.replay,count);
 }else{s.replay=true;waitingAck=false;}
}
void sampleSensors(){
 lastSoil=constrain(100.0f*analogRead(PIN_SOIL)/4095.0f,0.0f,100.0f);
 TempAndHumidity reading=dht.getTempAndHumidity();
 sensorValid=isfinite(reading.temperature)&&isfinite(reading.humidity);
 lastTemp=reading.temperature;lastHumid=reading.humidity;
 if(automatic){if(lastSoil<setpoint)setValve(true);else if(lastSoil>=setpoint+8)setValve(false);}
 Sample s={++sequence,uptimeMs(),lastSoil,lastTemp,lastHumid,valve,automatic,sensorValid,!connected()||count>0,setpoint};
 pushSample(s);
 // Registro do conjunto esperado, independente de publish/ACK: usado no teste fim a fim.
 JsonDocument d;fillSample(d,s);Serial.print("[COLETA] ");serializeJson(d,Serial);Serial.println();
 Serial.printf("[AMOSTRA] seq=%lu solo=%.1f buffer=%u online=%d\n",(unsigned long)s.seq,s.soil,count,connected());
}
void manageConnections(){
 bool block=digitalRead(PIN_NET)==HIGH;
 if(block!=netBlocked){
   netBlocked=block;
   if(block){
     updateIHM();
     if(mqtt.connected())mqtt.publish(topicStatus.c_str(),"offline",true);
     mqtt.disconnect();WiFi.disconnect(true,false);waitingAck=false;
     for(uint8_t i=0;i<count;i++)queueSamples[(head+i)%MAX_BUFFER].replay=true;
     Serial.println("[REDE] FALHA SIMULADA");
   }else{Serial.println("[REDE] RETORNO SIMULADO");lastConnect=millis()-RETRY_MS;}
 }
 if(netBlocked)return;
 if(WiFi.status()!=WL_CONNECTED){
   if(millis()-lastConnect>=RETRY_MS){lastConnect=millis();WiFi.begin("Wokwi-GUEST","",6);}
   return;
 }
 if(!mqtt.connected()&&millis()-lastConnect>=RETRY_MS){
   lastConnect=millis();
   if(mqtt.connect(clientId.c_str(),topicStatus.c_str(),0,true,"offline")){
     bool subscribed=mqtt.subscribe(topicCommand.c_str(),1)&&mqtt.subscribe(topicAck.c_str(),1);
     if(!subscribed){mqtt.disconnect();return;}
     waitingAck=false;
     for(uint8_t i=0;i<count;i++)queueSamples[(head+i)%MAX_BUFFER].replay=true;
     mqtt.publish(topicStatus.c_str(),"online",true);
     Serial.println("[MQTT] Online; sincronizacao com ACK");
   }else Serial.printf("[MQTT] erro=%d\n",mqtt.state());
 }
}
void setup(){
 Serial.begin(115200);
 bootId=String(esp_random(),HEX)+String(esp_random(),HEX);
 // Grupo, dispositivo e nonce por inicializacao: independe do MAC padrao Wokwi.
 clientId=String(BASE)+"-"+DEVICE+"-"+bootId;
 topicTelemetry=String(BASE)+"/telemetria";topicCommand=String(BASE)+"/comando";
 topicStatus=String(BASE)+"/status";topicAck=String(BASE)+"/ack";
 Serial.printf("[SESSAO] boot_id=%s client_id=%s\n",bootId.c_str(),clientId.c_str());
 pinMode(PIN_BUTTON,INPUT_PULLUP);pinMode(PIN_NET,INPUT_PULLDOWN);
 pinMode(PIN_LED_GREEN,OUTPUT);pinMode(PIN_LED_RED,OUTPUT);analogReadResolution(12);
 dht.setup(PIN_DHT,DHTesp::DHT22);servoValve.setPeriodHertz(50);servoValve.attach(PIN_SERVO,500,2400);setValve(false);
 Wire.begin(21,22);lcd.init();lcd.backlight();updateIHM();
 WiFi.mode(WIFI_STA);mqtt.setServer(BROKER,BROKER_PORT);mqtt.setCallback(onMessage);
 mqtt.setBufferSize(768);mqtt.setKeepAlive(10);mqtt.setSocketTimeout(1);
 lastConnect=millis()-RETRY_MS;lastSample=millis();
}
void loop(){
 manageConnections();
 if(connected())mqtt.loop();
 bool raw=digitalRead(PIN_BUTTON);
 if(raw!=rawButton){rawButton=raw;buttonChanged=millis();}
 if(raw!=stableButton&&millis()-buttonChanged>=40){
   stableButton=raw;
   if(stableButton==LOW){automatic=false;setValve(!valve);updateIHM();Serial.println("[BOTAO] MANUAL; valvula alternada");}
 }
 if(millis()-lastSample>=SAMPLE_MS){lastSample=millis();sampleSensors();}
 flushBuffer();
 if(millis()-lastLCD>=LCD_MS){lastLCD=millis();updateIHM();}
 delay(5);
}
