const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const HOST_PIN = '2146';

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 역할 정의
const ROLES = {
  RESEARCHER: {
    name: '수석 연구원',
    team: 'CLEAN',
    icon: '🧪',
    desc: '안정화 시약 5개를 합성하거나 스파이 수장을 격리(해고)시키면 승리합니다.'
  },
  SPY: {
    name: '산업 스파이',
    team: 'TOXIC',
    icon: '☣️',
    desc: '독성 시약 6개를 합성하거나, 독성 3개 이상일 때 스파이 수장을 실험담당자로 선출시키세요.'
  },
  MASTERMIND: {
    name: '스파이 수장',
    team: 'TOXIC',
    icon: '🧪',
    displayTeam: '스파이 진영 (수장)',
    iconOverride: '🕶️',
    desc: '스파이의 비밀 수장입니다. 독성 시약 3개 이상 누적 시 실험담당자로 선출되면 즉시 승리합니다!'
  },
  MODERATOR: {
    name: '진행 사회자',
    team: 'SPECTATOR',
    icon: '🎙️',
    desc: '게임에 직접 참여하지 않고 연구소 전체 진행 및 토론 시간을 통제합니다.'
  }
};

// 5~35인 황금 진영 밸런스 공식 (스파이 약 33~38% 비율, 수장 1명 포함)
function getAutoRoleDeck(total) {
  total = Math.max(5, Math.min(35, total));
  let totalToxic = 2; // 수장 1 + 일반 스파이

  if (total <= 6) totalToxic = 2;       // 5~6인: 수장 1 + 스파이 1, 연구원 3~4
  else if (total <= 8) totalToxic = 3;  // 7~8인: 수장 1 + 스파이 2, 연구원 4~5
  else if (total <= 10) totalToxic = 4; // 9~10인: 수장 1 + 스파이 3, 연구원 5~6
  else if (total <= 13) totalToxic = 5; // 11~13인: 수장 1 + 스파이 4
  else if (total <= 16) totalToxic = 6; // 14~16인: 수장 1 + 스파이 5
  else if (total <= 19) totalToxic = 7; // 17~19인: 수장 1 + 스파이 6
  else if (total <= 22) totalToxic = 8; // 20~22인: 수장 1 + 스파이 7
  else if (total <= 25) totalToxic = 9; // 23~25인: 수장 1 + 스파이 8
  else if (total <= 28) totalToxic = 10;// 26~28인: 수장 1 + 스파이 9
  else if (total <= 31) totalToxic = 11;// 29~31인: 수장 1 + 스파이 10
  else totalToxic = 12;                 // 32~35인: 수장 1 + 스파이 11

  const mastermind = 1;
  const spy = totalToxic - 1;
  const researcher = total - totalToxic;
  return { researcher, spy, mastermind, totalToxic, total };
}

// 시약 카드 창고 생성 (안정 촉매 6장, 독성 반응물 11장 = 총 17장)
function createShuffledDeck() {
  const deck = [];
  for (let i = 0; i < 6; i++) deck.push('CLEAN');
  for (let i = 0; i < 11; i++) deck.push('TOXIC');
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// 게임 전역 상태
const gameState = {
  phase: 'LOBBY', // LOBBY, NOMINATE_LEAD, VOTE_TEAM, DIRECTOR_DRAW, LEAD_PLAY, POWER_INVESTIGATE, POWER_SPECIAL_ELECTION, POWER_EXECUTE, GAME_OVER
  round: 1,
  players: [], // { socketId, token, id, name, role, isAlive, isHost, isModerator }
  roleDeckConfig: getAutoRoleDeck(5),
  deck: [],
  discard: [],
  cleanCount: 0, // 목표 5개
  toxicCount: 0, // 목표 6개 (3개 이상 시 수장 선출 승리)
  failTracker: 0, // 연속 부결 카운터 (3회 시 혼돈 반응)
  directorIndex: 0,
  directorId: null,
  leadId: null,
  lastDirectorId: null,
  lastLeadId: null,
  specialNextDirectorId: null,
  votes: {}, // { [voterId]: 'YES' | 'NO' }
  drawnCards: [], // 책임자가 뽑은 3장
  passedCards: [], // 실험담당자에게 넘긴 2장
  timerSeconds: 0,
  timerInterval: null,
  isTimerPaused: false,
  winner: null,
  winReason: null
};

// 유령 소켓 정리
function cleanupDeadSockets() {
  if (gameState.phase !== 'LOBBY') return;
  const activeSockets = io.sockets.sockets;
  gameState.players = gameState.players.filter(p => {
    const s = activeSockets.get(p.socketId);
    return s && s.connected;
  });
}

function broadcastSystemMsg(text) {
  io.emit('chat:message', {
    id: crypto.randomUUID(),
    sender: '📢 연구소 시스템',
    text,
    isSystem: true,
    time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  });
}

function broadcastState() {
  cleanupDeadSockets();
  const playingCount = gameState.players.filter(p => !p.isModerator).length;
  gameState.roleDeckConfig = getAutoRoleDeck(playingCount >= 5 ? playingCount : 5);

  const director = gameState.players.find(p => p.id === gameState.directorId);
  const lead = gameState.players.find(p => p.id === gameState.leadId);

  io.emit('state:update', {
    phase: gameState.phase,
    round: gameState.round,
    playerCount: gameState.players.length,
    playingCount,
    roleDeckConfig: gameState.roleDeckConfig,
    cleanCount: gameState.cleanCount,
    toxicCount: gameState.toxicCount,
    failTracker: gameState.failTracker,
    deckRemaining: gameState.deck.length,
    director: director ? { id: director.id, name: director.name } : null,
    lead: lead ? { id: lead.id, name: lead.name } : null,
    lastDirectorId: gameState.lastDirectorId,
    lastLeadId: gameState.lastLeadId,
    voteCount: Object.keys(gameState.votes).length,
    timerSeconds: gameState.timerSeconds,
    isTimerPaused: gameState.isTimerPaused,
    players: gameState.players.map(p => ({
      id: p.id,
      name: p.name,
      isAlive: p.isAlive,
      isHost: p.isHost,
      isModerator: p.isModerator,
      role: gameState.phase === 'GAME_OVER' || p.isModerator ? p.role : null
    })),
    winner: gameState.winner,
    winReason: gameState.winReason
  });
}

function startTimer(sec, onComplete) {
  clearInterval(gameState.timerInterval);
  gameState.timerSeconds = sec;
  gameState.isTimerPaused = false;
  io.emit('timer:tick', { seconds: gameState.timerSeconds, isPaused: false });

  gameState.timerInterval = setInterval(() => {
    if (!gameState.isTimerPaused) {
      gameState.timerSeconds--;
      io.emit('timer:tick', { seconds: gameState.timerSeconds, isPaused: false });
      if (gameState.timerSeconds <= 0) {
        clearInterval(gameState.timerInterval);
        if (onComplete) onComplete();
      }
    }
  }, 1000);
}

// 비밀 직업 카드 발송
function sendSecretRoles() {
  const playing = gameState.players.filter(p => !p.isModerator);
  const spies = playing.filter(p => p.role === 'SPY');
  const mastermind = playing.find(p => p.role === 'MASTERMIND');
  const isSmallGame = playing.length <= 7; // 5~7인 소규모에서는 수장도 스파이를 알 수 있음

  gameState.players.forEach(p => {
    if (!p.socketId) return;

    if (p.isModerator) {
      io.to(p.socketId).emit('secret_role', {
        role: 'MODERATOR',
        roleName: ROLES.MODERATOR.name,
        team: 'SPECTATOR',
        icon: ROLES.MODERATOR.icon,
        desc: ROLES.MODERATOR.desc,
        knownAllies: []
      });
      return;
    }

    const r = ROLES[p.role] || ROLES.RESEARCHER;
    let knownAllies = [];

    if (p.role === 'SPY') {
      spies.filter(s => s.id !== p.id).forEach(s => knownAllies.push(`${s.name} (일반 스파이)`));
      if (mastermind) knownAllies.push(`${mastermind.name} (스파이 수장 🕶️)`);
    } else if (p.role === 'MASTERMIND' && isSmallGame) {
      spies.forEach(s => knownAllies.push(`${s.name} (스파이 부하)`));
    }

    io.to(p.socketId).emit('secret_role', {
      role: p.role,
      roleName: r.name,
      team: r.team,
      icon: p.role === 'MASTERMIND' ? '🕶️' : r.icon,
      desc: r.desc,
      knownAllies
    });
  });
}

function checkDeckReplenish() {
  if (gameState.deck.length < 3) {
    gameState.deck = [...gameState.deck, ...gameState.discard];
    gameState.discard = [];
    for (let i = gameState.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [gameState.deck[i], gameState.deck[j]] = [gameState.deck[j], gameState.deck[i]];
    }
    broadcastSystemMsg(`🔄 시약 창고가 부족하여 버린 시약 더미를 섞어 보충했습니다. (총 ${gameState.deck.length}장)`);
  }
}

// 다음 연구책임자 지명 및 라운드 시작
function startNextRound() {
  const alivePlaying = gameState.players.filter(p => p.isAlive && !p.isModerator);
  if (alivePlaying.length === 0) return;

  if (gameState.specialNextDirectorId) {
    const special = alivePlaying.find(p => p.id === gameState.specialNextDirectorId);
    gameState.specialNextDirectorId = null;
    if (special) {
      gameState.directorId = special.id;
    } else {
      gameState.directorIndex = (gameState.directorIndex + 1) % alivePlaying.length;
      gameState.directorId = alivePlaying[gameState.directorIndex].id;
    }
  } else {
    gameState.directorIndex = gameState.directorIndex % alivePlaying.length;
    gameState.directorId = alivePlaying[gameState.directorIndex].id;
    gameState.directorIndex = (gameState.directorIndex + 1) % alivePlaying.length;
  }

  gameState.leadId = null;
  gameState.votes = {};
  gameState.phase = 'NOMINATE_LEAD';

  const director = gameState.players.find(p => p.id === gameState.directorId);
  broadcastState();
  broadcastSystemMsg(`📋 [라운드 ${gameState.round}] 연구책임자 [${director.name}] 님은 함께 시약을 합성할 '실험담당자'를 지명해 주세요!`);
}

// 합성 결과 정산 및 승리/특수능력 체크
function applySynthesizedReagent(type, isChaos = false) {
  if (type === 'CLEAN') {
    gameState.cleanCount++;
    broadcastSystemMsg(`🧪 [합성 결과] 안정 촉매 시약이 성공적으로 합성되었습니다! (안정 ${gameState.cleanCount} / 5)`);
  } else {
    gameState.toxicCount++;
    broadcastSystemMsg(`☠️ [합성 결과] 치명적인 독성 반응물이 플라스크에서 검출되었습니다! (독성 ${gameState.toxicCount} / 6)`);
  }

  // 승리 조건 체크
  if (gameState.cleanCount >= 5) {
    endGame('CLEAN', '수석 연구팀이 5개의 안정 촉매 시약을 모두 합성하여 신약 개발에 성공했습니다! 🧪');
    return;
  }
  if (gameState.toxicCount >= 6) {
    endGame('TOXIC', '독성 반응물이 6개 누적되어 연구소가 오염되었습니다! 산업 스파이 진영 승리! ☣️');
    return;
  }

  // 혼돈 반응이 아닐 때, 독성 시약이 투입되었다면 연구책임자에게 특수 분석 능력 부여!
  if (!isChaos && type === 'TOXIC') {
    const director = gameState.players.find(p => p.id === gameState.directorId);
    if (director && director.isAlive) {
      if (gameState.toxicCount === 1 || gameState.toxicCount === 2) {
        gameState.phase = 'POWER_INVESTIGATE';
        broadcastState();
        broadcastSystemMsg(`🧬 [특수 분석 발동] 연구책임자 [${director.name}] 님은 의심자 1명의 진영을 비밀리에 감식하세요!`);
        return;
      } else if (gameState.toxicCount === 3) {
        gameState.phase = 'POWER_SPECIAL_ELECTION';
        broadcastState();
        broadcastSystemMsg(`🔬 [특별 인사권 발동] 연구책임자 [${director.name}] 님은 다음 라운드 연구책임자를 직접 지명하세요!`);
        return;
      } else if (gameState.toxicCount === 4 || gameState.toxicCount === 5) {
        gameState.phase = 'POWER_EXECUTE';
        broadcastState();
        broadcastSystemMsg(`💉 [강제 격리 발동] 연구책임자 [${director.name}] 님은 의심스러운 연구원 1명을 영구 격리(탈락)시키세요!`);
        return;
      }
    }
  }

  // 특수 능력 없으면 바로 다음 라운드
  gameState.round++;
  startNextRound();
}

function endGame(winner, reason) {
  clearInterval(gameState.timerInterval);
  gameState.phase = 'GAME_OVER';
  gameState.winner = winner;
  gameState.winReason = reason;
  broadcastState();
  broadcastSystemMsg(`🏁 게임 종료! ${reason}`);
}

io.on('connection', (socket) => {
  socket.emit('init', { phase: gameState.phase });
  broadcastState();

  // 1. 입장 (1번째 사람 자동 방장 없음)
  socket.on('player:join', ({ name, token }) => {
    cleanupDeadSockets();
    let cleanName = (name || '').trim();
    if (!cleanName) cleanName = `연구원_${gameState.players.length + 1}`;

    let existing = gameState.players.find(p => (token && p.token === token) || p.socketId === socket.id || p.name === cleanName);

    if (existing) {
      existing.socketId = socket.id;
      if (token) existing.token = token;
      socket.emit('player:joined_success', {
        token: existing.token,
        id: existing.id,
        name: existing.name,
        isHost: existing.isHost,
        isModerator: existing.isModerator
      });
      if (existing.role) sendSecretRoles();
      broadcastState();
      return;
    }

    if (gameState.phase !== 'LOBBY') {
      socket.emit('error_message', '이미 연구가 진행 중입니다. 관전 모드로 접속합니다.');
      return;
    }

    if (gameState.players.length >= 35) {
      socket.emit('error_message', '최대 정원(35명)이 가득 찼습니다.');
      return;
    }

    const assignedToken = token || crypto.randomUUID();
    const newPlayer = {
      token: assignedToken,
      socketId: socket.id,
      id: crypto.randomUUID().slice(0, 8),
      name: cleanName,
      role: null,
      isAlive: true,
      isHost: false,
      isModerator: false
    };

    gameState.players.push(newPlayer);
    socket.emit('player:joined_success', {
      token: newPlayer.token,
      id: newPlayer.id,
      name: newPlayer.name,
      isHost: false,
      isModerator: false
    });

    broadcastSystemMsg(`${cleanName} 연구원이 실험실에 입장했습니다. (현재 ${gameState.players.length}명)`);
    broadcastState();
  });

  // 2. 방장 인증 (비밀번호: 2146)
  socket.on('host:claim', ({ pin }) => {
    if (pin === HOST_PIN) {
      const p = gameState.players.find(pl => pl.socketId === socket.id);
      if (p) {
        p.isHost = true;
        socket.emit('host:verified', { isHost: true, isModerator: p.isModerator });
        broadcastSystemMsg(`👑 [${p.name}] 님이 관리자 인증을 완료하여 방장 권한을 획득했습니다.`);
        broadcastState();
      }
    } else {
      socket.emit('error_message', '관리자 비밀번호가 올바르지 않습니다.');
    }
  });

  socket.on('host:set_mode', ({ isModerator }) => {
    const p = gameState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.isHost) return;
    p.isModerator = !!isModerator;
    broadcastSystemMsg(p.isModerator ? `🎙️ [${p.name}] 님이 [사회자 모드]를 선택했습니다.` : `🧪 [${p.name}] 님이 [참가자 모드]로 합류했습니다.`);
    broadcastState();
  });

  // 3. 타이머 일시정지 & 연장
  socket.on('timer:toggle', () => {
    const p = gameState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.isHost) return;
    gameState.isTimerPaused = !gameState.isTimerPaused;
    io.emit('timer:tick', { seconds: gameState.timerSeconds, isPaused: gameState.isTimerPaused });
    broadcastState();
  });

  socket.on('timer:add', ({ seconds }) => {
    const p = gameState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.isHost) return;
    gameState.timerSeconds += parseInt(seconds) || 30;
    io.emit('timer:tick', { seconds: gameState.timerSeconds, isPaused: gameState.isTimerPaused });
    broadcastState();
  });

  // 4. 게임 시작
  socket.on('host:start_game', () => {
    const sender = gameState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost || gameState.phase !== 'LOBBY') return;
    cleanupDeadSockets();

    const playing = gameState.players.filter(p => !p.isModerator);
    const total = playing.length;
    if (total < 5) {
      socket.emit('error_message', `현재 참여 인원이 ${total}명입니다. 최소 5명 이상이어야 시작할 수 있습니다.`);
      return;
    }

    gameState.roleDeckConfig = getAutoRoleDeck(total);
    const cfg = gameState.roleDeckConfig;
    const rolesDeck = ['MASTERMIND'];
    for (let i = 0; i < cfg.spy; i++) rolesDeck.push('SPY');
    for (let i = 0; i < cfg.researcher; i++) rolesDeck.push('RESEARCHER');

    for (let i = rolesDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rolesDeck[i], rolesDeck[j]] = [rolesDeck[j], rolesDeck[i]];
    }

    playing.forEach((p, idx) => {
      p.role = rolesDeck[idx];
      p.isAlive = true;
    });

    gameState.deck = createShuffledDeck();
    gameState.discard = [];
    gameState.cleanCount = 0;
    gameState.toxicCount = 0;
    gameState.failTracker = 0;
    gameState.round = 1;
    gameState.directorIndex = 0;
    gameState.lastDirectorId = null;
    gameState.lastLeadId = null;
    gameState.specialNextDirectorId = null;
    gameState.winner = null;
    gameState.winReason = null;

    sendSecretRoles();
    broadcastSystemMsg(`🧪 연구가 시작되었습니다! (총 ${total}명: 수석 연구팀 ${cfg.researcher}명, 스파이 ${cfg.totalToxic}명 [수장 1명 포함])`);
    startNextRound();
  });

  // 5. 실험담당자 지명
  socket.on('director:nominate_lead', ({ leadId }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== gameState.directorId || gameState.phase !== 'NOMINATE_LEAD') return;

    const target = gameState.players.find(p => p.id === leadId && p.isAlive && !p.isModerator);
    if (!target || target.id === player.id) return;

    gameState.leadId = target.id;
    gameState.votes = {};
    gameState.phase = 'VOTE_TEAM';
    broadcastState();
    broadcastSystemMsg(`🗳️ 연구책임자 [${player.name}] 님이 [${target.name}] 님을 실험담당자로 추천했습니다. 찬반 투표를 진행해 주세요! (30초)`);

    startTimer(30, () => resolveTeamVote());
  });

  // 6. 찬반 신임 투표
  socket.on('player:vote_team', ({ vote }) => {
    const voter = gameState.players.find(p => p.socketId === socket.id);
    if (!voter || !voter.isAlive || voter.isModerator || gameState.phase !== 'VOTE_TEAM') return;

    gameState.votes[voter.id] = vote; // 'YES' or 'NO'
    broadcastState();

    const aliveCount = gameState.players.filter(p => p.isAlive && !p.isModerator).length;
    if (Object.keys(gameState.votes).length >= aliveCount) {
      clearInterval(gameState.timerInterval);
      resolveTeamVote();
    }
  });

  function resolveTeamVote() {
    const alivePlaying = gameState.players.filter(p => p.isAlive && !p.isModerator);
    let yesVotes = 0, noVotes = 0;
    alivePlaying.forEach(p => {
      if (gameState.votes[p.id] === 'YES') yesVotes++;
      else noVotes++;
    });

    const passed = yesVotes > noVotes;
    const lead = gameState.players.find(p => p.id === gameState.leadId);

    if (passed) {
      broadcastSystemMsg(`✅ 신임 투표 가결! (찬성 ${yesVotes} : 반대 ${noVotes}) — [${lead.name}] 실험담당자 승인!`);
      gameState.failTracker = 0;

      // 스파이 수장 선출 승리 조건 체크 (독성 시약 3개 이상 누적 시)
      if (gameState.toxicCount >= 3 && lead.role === 'MASTERMIND') {
        endGame('TOXIC', `독성 반응물 3개 이상 누적 상태에서 스파이 수장 [${lead.name}] 님이 실험담당자로 선출되었습니다! 산업 스파이 진영 즉시 승리! 🕶️`);
        return;
      }

      // 이전 임기 기록
      gameState.lastDirectorId = gameState.directorId;
      gameState.lastLeadId = gameState.leadId;

      // 시약 창고에서 3장 뽑기
      checkDeckReplenish();
      gameState.drawnCards = [gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop()];
      gameState.phase = 'DIRECTOR_DRAW';
      broadcastState();

      const director = gameState.players.find(p => p.id === gameState.directorId);
      if (director && director.socketId) {
        io.to(director.socketId).emit('director:cards', gameState.drawnCards);
      }
      broadcastSystemMsg(`🔬 연구책임자 [${director.name}] 님이 시약 창고에서 3장의 시약을 꺼내 검토 중입니다...`);
    } else {
      gameState.failTracker++;
      broadcastSystemMsg(`❌ 신임 투표 부결! (찬성 ${yesVotes} : 반대 ${noVotes}) — 연속 부결: ${gameState.failTracker} / 3`);

      if (gameState.failTracker >= 3) {
        gameState.failTracker = 0;
        gameState.lastDirectorId = null;
        gameState.lastLeadId = null;
        checkDeckReplenish();
        const chaosCard = gameState.deck.pop();
        broadcastSystemMsg(`💥 연속 3회 부결로 연구소가 혼돈 상태에 빠졌습니다! 창고 맨 위 시약이 무작위로 플라스크에 투입됩니다!`);
        applySynthesizedReagent(chaosCard, true);
      } else {
        gameState.round++;
        startNextRound();
      }
    }
  }

  // 7. 연구책임자 3장 중 1장 버리기 -> 2장 전달
  socket.on('director:discard_card', ({ discardIndex }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== gameState.directorId || gameState.phase !== 'DIRECTOR_DRAW') return;

    const idx = parseInt(discardIndex);
    if (isNaN(idx) || idx < 0 || idx > 2) return;

    const discarded = gameState.drawnCards.splice(idx, 1)[0];
    gameState.discard.push(discarded);
    gameState.passedCards = [...gameState.drawnCards];
    gameState.drawnCards = [];

    gameState.phase = 'LEAD_PLAY';
    broadcastState();

    const lead = gameState.players.find(p => p.id === gameState.leadId);
    if (lead && lead.socketId) {
      io.to(lead.socketId).emit('lead:cards', gameState.passedCards);
    }
    broadcastSystemMsg(`⚗️ [${lead.name}] 실험담당자가 2장의 시약을 넘겨받아 최종 1장을 플라스크에 투입하려 합니다...`);
  });

  // 8. 실험담당자 2장 중 1장 최종 투입
  socket.on('lead:play_card', ({ playIndex }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== gameState.leadId || gameState.phase !== 'LEAD_PLAY') return;

    const idx = parseInt(playIndex);
    if (isNaN(idx) || idx < 0 || idx > 1) return;

    const playedCard = gameState.passedCards.splice(idx, 1)[0];
    const discarded = gameState.passedCards[0];
    gameState.discard.push(discarded);
    gameState.passedCards = [];

    applySynthesizedReagent(playedCard, false);
  });

  // 9. 연구책임자 특수 분석 능력 실행
  socket.on('power:investigate', ({ targetId }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== gameState.directorId || gameState.phase !== 'POWER_INVESTIGATE') return;

    const target = gameState.players.find(p => p.id === targetId && p.isAlive && !p.isModerator);
    if (target) {
      const teamText = ROLES[target.role].team === 'CLEAN' ? '🧪 수석 연구팀 (안정 진영)' : '☣️ 산업 스파이 (오염 진영)';
      socket.emit('power:result', {
        title: '🧬 진영 감식 결과',
        message: `[${target.name}] 연구원의 정밀 감식 결과: ${teamText} 소속입니다!`
      });
      broadcastSystemMsg(`🧬 연구책임자 [${player.name}] 님이 [${target.name}] 님의 시약 성분을 비밀리에 감식했습니다.`);
      gameState.round++;
      startNextRound();
    }
  });

  socket.on('power:special_election', ({ targetId }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== gameState.directorId || gameState.phase !== 'POWER_SPECIAL_ELECTION') return;

    const target = gameState.players.find(p => p.id === targetId && p.isAlive && !p.isModerator);
    if (target) {
      gameState.specialNextDirectorId = target.id;
      broadcastSystemMsg(`🔬 연구책임자 [${player.name}] 님이 [${target.name}] 님을 다음 연구책임자로 특별 임명했습니다.`);
      gameState.round++;
      startNextRound();
    }
  });

  socket.on('power:execute', ({ targetId }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== gameState.directorId || gameState.phase !== 'POWER_EXECUTE') return;

    const target = gameState.players.find(p => p.id === targetId && p.isAlive && !p.isModerator);
    if (target) {
      target.isAlive = false;
      broadcastSystemMsg(`💉 [강제 격리] 연구책임자 [${player.name}] 님이 [${target.name}] 연구원을 연구소에서 영구 격리(탈락)시켰습니다!`);

      if (target.role === 'MASTERMIND') {
        endGame('CLEAN', `스파이 수장 [${target.name}] 님이 강제 격리(제거)되었습니다! 수석 연구팀 완벽한 승리! 🧪`);
        return;
      }

      gameState.round++;
      startNextRound();
    }
  });

  // 10. 실시간 채팅
  socket.on('chat:send', ({ text }) => {
    const sender = gameState.players.find(p => p.socketId === socket.id);
    if (!sender || !text.trim()) return;

    if (!sender.isAlive && !sender.isModerator) {
      socket.emit('error_message', '격리(탈락)된 연구원은 전체 토론에 발언할 수 없습니다.');
      return;
    }

    const cleanText = text.trim().slice(0, 150);
    io.emit('chat:message', {
      id: crypto.randomUUID(),
      sender: sender.isModerator ? `🎙️ [사회자] ${sender.name}` : sender.name,
      text: cleanText,
      isModerator: sender.isModerator,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // 11. 다음 판 준비 & 완전 초기화
  socket.on('host:reset_game', () => {
    const sender = gameState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost) return;

    clearInterval(gameState.timerInterval);
    gameState.phase = 'LOBBY';
    gameState.round = 1;
    gameState.isTimerPaused = false;
    cleanupDeadSockets();

    gameState.players.forEach(p => {
      p.role = null;
      p.isAlive = true;
    });
    gameState.cleanCount = 0;
    gameState.toxicCount = 0;
    gameState.failTracker = 0;
    gameState.winner = null;
    gameState.winReason = null;

    io.emit('synthesis:player_reset');
    broadcastSystemMsg(`🔄 방장이 다음 연구를 준비했습니다.`);
    broadcastState();
  });

  socket.on('host:kick_all', () => {
    const sender = gameState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost) return;
    clearInterval(gameState.timerInterval);
    gameState.phase = 'LOBBY';
    gameState.players = [];
    io.emit('synthesis:force_kick');
    broadcastState();
  });

  socket.on('disconnect', () => {
    if (gameState.phase === 'LOBBY') {
      cleanupDeadSockets();
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🧪 5~35인 시크릿 신세시스(Secret Synthesis) 서버 가동!`);
  console.log(`접속 주소: http://localhost:${PORT}`);
  console.log(`=================================================`);
});
