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
let isSendingData = false; // 전송 락
let lastCommand = ""; // 중복 전송 방지용

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
    numHands: 2 // 양쪽 화면에 각각 1개씩 인식하도록 최대 2개로 유지
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

  if (results.landmarks) {
    for (const landmarks of results.landmarks) {
      const wrist = landmarks[0]; 
      const visualX = 1 - wrist.x; // 좌우 반전 좌표

      const gesture = detectGesture(landmarks);

      // 화면 왼쪽(0~0.5)은 Left Player
      if (visualX < 0.5) {
        leftState = gesture;
        leftLandmarks = landmarks;
      } else {
        // 화면 오른쪽(0.5~1)은 Right Player
        rightState = gesture;
        rightLandmarks = landmarks;
      }
    }
  }

  // 명령어 판단 로직
  let command = "stop";
  if (leftState === 'open' && rightState === 'open') {
    command = "forward";
  } else if (leftState === 'fist' && rightState === 'open') {
    command = "right";
  } else if (leftState === 'open' && rightState === 'fist') {
    command = "left";
  } else if (leftState === 'fist' && rightState === 'fist') {
    command = "backward";
  } else {
    // 하나라도 인식 안 되면 stop
    command = "stop"; 
  }

  // 스켈레톤 인디케이터 그리기
  if (leftLandmarks) drawHandSkeleton(leftLandmarks, leftState, "P1");
  if (rightLandmarks) drawHandSkeleton(rightLandmarks, rightState, "P2");

  updateUI(leftState, rightState, command);
  
  // 상태가 바뀌었거나 연결되어 있을 때 데이터를 전송 (블루투스 부하 최소화)
  if (command !== lastCommand) {
    sendBluetoothData(command);
    lastCommand = command;
  }

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
  isSendingData = false;
  lastCommand = "";
}

btnDisconnect.addEventListener('click', () => {
    if(bluetoothDevice && bluetoothDevice.gatt.connected) {
        bluetoothDevice.gatt.disconnect();
    }
});

// ★ 에러 및 함정 해결된 데이터 전송 함수
async function sendBluetoothData(str) {
  logPacket.innerText = str;
  if (!isConnected || !rxCharacteristic || isSendingData) return;

  try {
    isSendingData = true; 
    const encoder = new TextEncoder();
    
    // 1. writeValueWithoutResponse 로 변경하여 NotSupportedError 해결
    // 2. "\r\n"을 "\n"으로 변경하여 마이크로비트에서 글자를 정확히 인식하도록 해결
    await rxCharacteristic.writeValueWithoutResponse(encoder.encode(str + "\n"));
    
  } catch (e) {
    console.error("TX Error", e);
  } finally {
    isSendingData = false; 
  }
}

// 앱 시작
createHandLandmarker();
