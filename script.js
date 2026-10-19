import { CommandSender, resolveCommand } from "./control.mjs";
import {
  HandLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0";

/** * 설정 변수 */
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
let commandSender = null;

// DOM 요소
const btnConnect = document.getElementById("connect-btn");
const btnDisconnect = document.getElementById("disconnect-btn");
const statusBt = document.getElementById("bt-status");
const logLeft = document.getElementById("log-left");
const logRight = document.getElementById("log-right");
const logCommand = document.getElementById("log-command");
const logPacket = document.getElementById("packet-log");
const modelStatus = document.getElementById("model-status");

// 손가락 관절 연결선 정의 (스켈레톤용)
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],       // 엄지
  [0, 5], [5, 6], [6, 7], [7, 8],       // 검지
  [5, 9], [9, 10], [10, 11], [11, 12],  // 중지
  [9, 13], [13, 14], [14, 15], [15, 16],// 약지
  [13, 17], [17, 18], [18, 19], [19, 20],// 새끼
  [0, 17]                               // 손바닥 밑둥
];

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
    numHands: 2 // 한 사람의 양손 인식
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

  // 상태 초기화
  let leftState = 'none';
  let rightState = 'none';
  let leftLandmarks = null;
  let rightLandmarks = null;
  let leftCount = 0, rightCount = 0;

  if (results.landmarks) {
    for (const landmarks of results.landmarks) {
      const wrist = landmarks[0]; 
      const visualX = 1 - wrist.x; // 좌우 반전 좌표

      const gesture = detectGesture(landmarks);

      // 화면 왼쪽 손
      if (visualX < 0.5) {
        leftCount++;
        leftState = gesture;
        leftLandmarks = landmarks;
      } else {
        // 화면 오른쪽 손
        rightCount++;
        rightState = gesture;
        rightLandmarks = landmarks;
      }
    }
  }

  // 각 화면 영역에 손이 정확히 하나씩 있어야 조종합니다.
  if (leftCount !== 1) leftState = 'none';
  if (rightCount !== 1) rightState = 'none';
  const command = resolveCommand(leftState, rightState);

  // 스켈레톤 인디케이터 그리기
  if (leftLandmarks) drawHandSkeleton(leftLandmarks, leftState, "왼쪽");
  if (rightLandmarks) drawHandSkeleton(rightLandmarks, rightState, "오른쪽");

  updateUI(leftState, rightState, command);
  
  sendBluetoothData(command);

  window.requestAnimationFrame(predictWebcam);
}

// 4. 제스처(주먹/보자기) 인식
function detectGesture(landmarks) {
  const wrist = landmarks[0];
  // 검지, 중지, 약지, 새끼 손가락의 끝마디(tip)와 엉덩이관절(mcp) 인덱스
  const tips = [8, 12, 16, 20];
  const mcps = [5, 9, 13, 17];
  
  let foldedCount = 0;
  
  for (let i = 0; i < 4; i++) {
    const tipDist = Math.hypot(landmarks[tips[i]].x - wrist.x, landmarks[tips[i]].y - wrist.y);
    const mcpDist = Math.hypot(landmarks[mcps[i]].x - wrist.x, landmarks[mcps[i]].y - wrist.y);
    
    // 손가락 끝이 관절보다 손목에 가까워지면 접힌 것으로 판단
    if (tipDist < mcpDist) {
      foldedCount++;
    }
  }
  
  // 4개 중 3개 이상 접히면 주먹, 그 외는 보자기
  return foldedCount >= 3 ? 'fist' : 'open';
}

// 5. 스켈레톤 그리기 함수
function drawHandSkeleton(landmarks, state, side) {
  ctx.save();
  // 보자기: 초록색 라인, 주먹: 빨간색 라인
  ctx.strokeStyle = state === 'open' ? "#00E676" : "#EA4335"; 
  ctx.lineWidth = 4;
  ctx.lineCap = "round";

  // 뼈대(선) 그리기
  ctx.beginPath();
  for (const connection of HAND_CONNECTIONS) {
    const start = landmarks[connection[0]];
    const end = landmarks[connection[1]];

    // 화면이 거울 모드이므로 X 좌표는 1에서 빼주어야 함 (1 - x)
    const startX = (1 - start.x) * canvas.width;
    const startY = start.y * canvas.height;
    const endX = (1 - end.x) * canvas.width;
    const endY = end.y * canvas.height;

    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
  }
  ctx.stroke();

  // 관절(점) 그리기
  ctx.fillStyle = "#ffffff";
  for (const landmark of landmarks) {
    const px = (1 - landmark.x) * canvas.width;
    const py = landmark.y * canvas.height;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, 2 * Math.PI);
    ctx.fill();
  }

  // 텍스트 라벨 (손목 위치 기준)
  const wristX = (1 - landmarks[0].x) * canvas.width;
  const wristY = landmarks[0].y * canvas.height;
  const emoji = state === 'open' ? '🖐️' : '✊';
  
  ctx.fillStyle = "#fff";
  ctx.font = "bold 24px Pretendard";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 4;
  ctx.fillText(`${side} ${emoji}`, wristX + 25, wristY + 15);

  ctx.restore();
}

function updateUI(left, right, cmd) {
  const stateStr = { 'open': '보자기 🖐️', 'fist': '주먹 ✊', 'none': '인식 안됨 ❌' };
  
  logLeft.innerText = stateStr[left];
  logRight.innerText = stateStr[right];
  logCommand.innerText = cmd.toUpperCase();

  logLeft.style.color = left === 'none' ? "#aaa" : "#000";
  logRight.style.color = right === 'none' ? "#aaa" : "#000";
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
    rxCharacteristic = await service.getCharacteristic(BLUETOOTH_UUID_RX);

    const characteristic = rxCharacteristic;
    commandSender = new CommandSender(
      command => characteristic.writeValueWithoutResponse(new TextEncoder().encode(command + "\n")),
      command => { logPacket.innerText = command; },
      error => { console.error("TX Error", error); logPacket.innerText = "전송 실패 · 재시도 중"; }
    );
    isConnected = true;
    statusBt.innerText = "연결됨: " + bluetoothDevice.name;
    statusBt.classList.add("status-connected");
    btnConnect.classList.add("hidden");
    btnDisconnect.classList.remove("hidden");
    
    // 초기값 전송
    sendBluetoothData("stop");
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
  commandSender?.close();
  commandSender = null;
  rxCharacteristic = null;
  logPacket.innerText = "연결 해제됨";
}

btnDisconnect.addEventListener('click', () => {
    if(bluetoothDevice && bluetoothDevice.gatt.connected) {
        bluetoothDevice.gatt.disconnect();
    }
});

// 완료된 쓰기만 전송 내역에 표시합니다. 전송 중 발생한 정지는 먼저 처리합니다.
function sendBluetoothData(command) {
  if (isConnected && commandSender) commandSender.request(command);
}

// 앱 시작
createHandLandmarker();
