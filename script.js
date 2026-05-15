import {
  HandLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0";

/** * 설정 변수 */
const DEADZONE_MIN = 0.40; // 0~40% 전진
const DEADZONE_MAX = 0.60; // 60~100% 후진
const BLUETOOTH_UUID_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
// RX UUID (Write): 끝자리 3
const BLUETOOTH_UUID_RX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; 

let handLandmarker = undefined;
let webcam = null;
let canvas, ctx;
let lastVideoTime = -1;
let results = undefined;

// 블루투스 변수
let bluetoothDevice, rxCharacteristic;
let isConnected = false;
let isSendingData = false; // 전송 락

// DOM 요소
const btnConnect = document.getElementById("connect-btn");
const btnDisconnect = document.getElementById("disconnect-btn");
const statusBt = document.getElementById("bt-status");
const logLeft = document.getElementById("log-left");
const logRight = document.getElementById("log-right");
const logPacket = document.getElementById("packet-log");
const modelStatus = document.getElementById("model-status");

// 1. 모델 초기화
async function createHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
  );
  
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numHands: 2
  });
  
  modelStatus.innerText = "AI 모델 준비 완료";
  modelStatus.classList.add("ready");
  startWebcam();
}

// 2. 웹캠 시작
function startWebcam() {
  webcam = document.getElementById("webcam");
  canvas = document.getElementById("output_canvas");
  ctx = canvas.getContext("2d");

  // 가로 모드 최적화 해상도
  const constraints = { video: { width: 1280, height: 720 } };

  navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
    webcam.srcObject = stream;
    webcam.addEventListener("loadeddata", predictWebcam);
  });
}

// 3. 메인 루프
async function predictWebcam() {
  if (canvas.width !== webcam.videoWidth) {
    canvas.width = webcam.videoWidth;
    canvas.height = webcam.videoHeight;
  }

  let startTimeMs = performance.now();
  if (lastVideoTime !== webcam.currentTime) {
    lastVideoTime = webcam.currentTime;
    results = handLandmarker.detectForVideo(webcam, startTimeMs);
  }

  // 화면 그리기 (거울 모드)
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(webcam, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  // 손 인식 및 모터 값 계산
  let leftMotor = { dir: 'F', speed: 0 };
  let rightMotor = { dir: 'F', speed: 0 };

  if (results.landmarks) {
    for (const landmarks of results.landmarks) {
      const wrist = landmarks[0]; 
      const visualX = 1 - wrist.x; // 좌우 반전 좌표
      const visualY = wrist.y;

      const motorData = calculateMotorValue(visualY);

      // 화면 왼쪽(0~0.5)은 Left Motor
      if (visualX < 0.5) {
        leftMotor = motorData;
        drawHandIndicator(visualX, visualY, motorData, "L");
      } else {
        rightMotor = motorData;
        drawHandIndicator(visualX, visualY, motorData, "R");
      }
    }
  }

  updateUI(leftMotor, rightMotor);
  
  // 패킷 생성 (LFxxxRFxxx)
  const lSpeedStr = String(leftMotor.speed).padStart(3, '0');
  const rSpeedStr = String(rightMotor.speed).padStart(3, '0');
  const packet = `L${leftMotor.dir}${lSpeedStr}R${rightMotor.dir}${rSpeedStr}`;
  
  sendBluetoothData(packet);

  window.requestAnimationFrame(predictWebcam);
}

// 모터 값 계산 (Deadzone 적용)
function calculateMotorValue(y) {
  let speed = 0;
  let dir = 'F';

  if (y < DEADZONE_MIN) {
    // 전진 (0 ~ 0.4)
    let ratio = (DEADZONE_MIN - y) / DEADZONE_MIN;
    speed = Math.min(255, Math.floor(ratio * 255));
    dir = 'F';
  } else if (y > DEADZONE_MAX) {
    // 후진 (0.6 ~ 1.0)
    let ratio = (y - DEADZONE_MAX) / (1.0 - DEADZONE_MAX);
    speed = Math.min(255, Math.floor(ratio * 255));
    dir = 'B';
  } else {
    // 정지
    speed = 0;
  }
  return { dir, speed };
}

// 손 위치 시각화 (동그라미)
function drawHandIndicator(x, y, data, side) {
  const px = x * canvas.width;
  const py = y * canvas.height;
  
  ctx.beginPath();
  ctx.arc(px, py, 20, 0, 2 * Math.PI); 
  ctx.fillStyle = data.speed > 0 ? (data.dir === 'F' ? "#00E676" : "#EA4335") : "#888";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#fff";
  ctx.stroke();

  // 텍스트 라벨
  ctx.fillStyle = "#fff";
  ctx.font = "bold 24px Pretendard";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 4;
  ctx.fillText(`${side}`, px + 25, py + 8);
}

function updateUI(l, r) {
  logLeft.innerText = l.speed === 0 ? "Stop" : `${l.dir} ${l.speed}`;
  logRight.innerText = r.speed === 0 ? "Stop" : `${r.dir} ${r.speed}`;
  
  logLeft.style.color = l.speed === 0 ? "#aaa" : (l.dir === 'F' ? "#00aa00" : "#d00");
  logRight.style.color = r.speed === 0 ? "#aaa" : (r.dir === 'F' ? "#00aa00" : "#d00");
}

/* --- 블루투스 로직 --- */
btnConnect.addEventListener('click', async () => {
  try {
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "BBC micro:bit" }],
      optionalServices: [BLUETOOTH_UUID_SERVICE]
    });
    
    bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(BLUETOOTH_UUID_SERVICE);
    // RX (Write) 주소 사용
    rxCharacteristic = await service.getCharacteristic(BLUETOOTH_UUID_RX);

    isConnected = true;
    statusBt.innerText = "연결됨: " + bluetoothDevice.name;
    statusBt.classList.add("status-connected");
    btnConnect.classList.add("hidden");
    btnDisconnect.classList.remove("hidden");
    
  } catch (error) {
    console.log(error);
    alert("연결 실패: " + error);
  }
});

function onDisconnected() {
  isConnected = false;
  statusBt.innerText = "연결 해제됨";
  statusBt.classList.remove("status-connected");
  btnConnect.classList.remove("hidden");
  btnDisconnect.classList.add("hidden");
  isSendingData = false;
}

btnDisconnect.addEventListener('click', () => {
    if(bluetoothDevice && bluetoothDevice.gatt.connected) {
        bluetoothDevice.gatt.disconnect();
    }
});

async function sendBluetoothData(str) {
  if (!isConnected || !rxCharacteristic || isSendingData) return;
  
  logPacket.innerText = str;

  try {
    isSendingData = true; 
    const encoder = new TextEncoder();
    // ★ 줄바꿈 문자 \r\n 추가
    await rxCharacteristic.writeValue(encoder.encode(str + "\r\n"));
  } catch (e) {
    console.error("TX Error", e);
  } finally {
    isSendingData = false; 
  }
}

// 앱 시작
createHandLandmarker();
