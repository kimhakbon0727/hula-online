# 훌라 온라인

브라우저로 여럿이 함께 즐기는 **훌라(Korean rummy)** 멀티플레이 게임 서버입니다.
방 코드로 입장하고, 사람이 모자라면 봇을 추가해서 할 수 있습니다.

- Node.js + WebSocket(`ws`) 서버, 별도 DB 없음 (방은 메모리에만 존재)
- 방 코드/초대 링크 입장, 봇, 재접속, 방장 이관
- 방 설정: K-A-2 돌아가기, 땡큐, 스톱 기준 점수, 제한 시간

## 실행

```bash
git clone <이 저장소 주소>
cd hula-online
npm install --omit=dev
npm start                  # http://localhost:3000
PORT=8080 npm start        # 포트 변경
```

Node.js 18 이상이 필요합니다.

같은 네트워크의 다른 기기에서는 `http://<서버 IP>:<포트>` 로 접속합니다.

### WSL2에서 같은 네트워크의 친구를 받으려면
WSL2는 가상 네트워크라서 윈도우에서 포트를 넘겨주어야 합니다. **관리자 PowerShell**:

```powershell
$wsl = ((wsl hostname -I) -split ' ')[0].Trim()
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$wsl
New-NetFirewallRule -DisplayName "Hula 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
netsh interface portproxy show v4tov4
```

WSL을 재시작해 IP가 바뀌면 `portproxy`를 다시 설정하세요.
인터넷 너머의 사람과 하려면 공유기 포트포워딩 대신 Tailscale이나 Cloudflare Tunnel 같은 방법을 권장합니다.

## 규칙 요약

- 조커 없는 52장, 2~5명, 7장씩 받습니다.
- 차례: 뽑기(더미 또는 버린 카드) → 등록/붙이기 → 한 장 버리기
- **땡**: 같은 숫자 3~4장 / **런**: 같은 무늬 연속 3장 이상 / **7 단독** 등록 가능
- 등록한 뒤에는 남의 멜드에도 붙일 수 있습니다.
- 판이 끝나는 경우
  - 손패 모두 털기, **훌라**(첫 등록과 동시에 모두 털기)
  - **스톱**(손패 점수가 기준 이하일 때 선언)
  - **블라스트**(미등록 상태 7장 합이 15 이하 또는 83 이상)
  - **7 네 장**, 더미 소진
- 점수: A=1, J/Q/K=11/12/13, 손에 남은 7=14점
- 정산: 진 사람이 (자기 점수 − 승자 점수)를 승자에게 지불. 훌라 ×4, 블라스트 ×2, 7 네 장 ×2, 미등록 패배 ×2, 스톱 실패 ×2
- 배수는 `shared/rules.js`의 `MULT`에서 바꿀 수 있습니다.

## 개발

```bash
npm test                              # 규칙 단위 테스트
npm run sim                           # 봇 대전 시뮬레이션
HULA_BOT_DELAY=20 node test/e2e.js    # 서버 E2E 테스트
```

```
server.js        HTTP 정적 서빙 + WebSocket
lib/game.js      한 판의 상태 머신(규칙)
lib/room.js      방, 멤버, 타이머
lib/bot.js       봇 로직
shared/rules.js  서버/브라우저 공용 규칙 함수
public/          웹 클라이언트
test/            단위/시뮬레이션/E2E 테스트
```

환경변수: `PORT`(기본 3000), `HOST`(기본 0.0.0.0), `HULA_BOT_DELAY`(봇 동작 간격 ms, 기본 900)
