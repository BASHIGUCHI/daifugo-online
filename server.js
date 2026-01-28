const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

/* --- 設定 --- */
const MAX_ROUNDS = 5;
const SCORES = { 0: 2, 1: 1, 2: -1, 3: -2 }; 

/* --- ルーム管理 --- */
let rooms = {};
const SUITS = ['♠', '♥', '♦', '♣'];

function createDeck() {
    let deck = [];
    for(let s of SUITS) {
        for(let n=1; n<=13; n++) {
            let str = (n===1)?11 : (n===2)?12 : (n-3);
            deck.push({ suit:s, num:n, str:str, isJoker:false, id: Math.random().toString(36) });
        }
    }
    deck.push({ suit:'JK', num:0, str:13, isJoker:true, id:'j1' });
    deck.push({ suit:'JK', num:0, str:13, isJoker:true, id:'j2' });
    return deck.sort(() => Math.random() - 0.5);
}

function createInitialState() {
    return {
        round: 1,
        turn: 0,
        field: [],
        passed: [],
        winners: [],
        fouled: [],
        isRevolution: false,
        isElevenBack: false,
        isBind: false,     // 縛り状態
        lastPlayType: "single",
        lastPlayer: -1, 
        gameover: false
    };
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        let mode = data.mode;
        let name = (data.name || "Guest").substring(0, 10);
        let roomName;

        if (mode === 'single') {
            roomName = `single_${socket.id}`;
            rooms[roomName] = {
                players: [],
                gameState: createInitialState(),
                mode: 'single',
                id: roomName
            };
            joinRoom(socket, roomName, name, false);
            for(let i=1; i<=3; i++) {
                rooms[roomName].players.push({ 
                    id: `cpu_${i}`, hand: [], name: `CPU ${i}`, isBot: true, score: 0 
                });
            }
            startGame(roomName);
        } else {
            roomName = (data.roomName || "default").substring(0, 15);
            if (!rooms[roomName]) {
                rooms[roomName] = {
                    players: [],
                    gameState: createInitialState(),
                    mode: 'multi',
                    id: roomName
                };
            }
            let room = rooms[roomName];
            if (room.players.length < 4 && room.gameState.round === 1 && !room.gameState.turn) {
                joinRoom(socket, roomName, name, false);
                if (room.players.length === 4) startGame(roomName);
            } else {
                socket.emit('gameFull');
            }
        }
    });

    socket.on('playCard', (data) => {
        let roomName = socket.data.roomName;
        if (!roomName || !rooms[roomName]) return;
        let room = rooms[roomName];
        let pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx === -1 || pIdx !== room.gameState.turn) return;

        let cards = data.cardIds.map(cid => room.players[pIdx].hand.find(c => c.id === cid)).filter(c => c);
        let check = checkRules(cards, room.gameState);
        if (check.ok) processPlay(room, pIdx, cards, check.type);
    });

    socket.on('pass', () => {
        let roomName = socket.data.roomName;
        if (!roomName || !rooms[roomName]) return;
        let room = rooms[roomName];
        let pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx === -1 || pIdx !== room.gameState.turn) return;
        processPass(room, pIdx);
    });

    socket.on('disconnect', () => {
        let roomName = socket.data.roomName;
        if (roomName && rooms[roomName]) {
            let room = rooms[roomName];
            if (room.mode === 'multi') {
                room.players = room.players.filter(p => p.id !== socket.id);
                if (room.players.length === 0) {
                    delete rooms[roomName];
                } else {
                    room.gameState = createInitialState();
                    broadcastToRoom(roomName, 'msg', "切断発生。リロード推奨。");
                    broadcastToRoom(roomName, 'gameFull');
                }
            } else {
                delete rooms[roomName];
            }
        }
    });
});

function joinRoom(socket, roomName, name, isBot) {
    let room = rooms[roomName];
    if(!room.id) room.id = roomName;
    socket.join(roomName);
    socket.data.roomName = roomName;
    socket.data.name = name;
    room.players.push({ id: socket.id, hand: [], name: name, isBot: isBot, score: 0 });
    socket.emit('initInfo', { myIdx: room.players.length - 1, roomName: roomName });
    broadcastToRoom(roomName, 'playerUpdate', { count: room.players.length, names: room.players.map(p => p.name) });
}

function broadcastToRoom(roomName, event, data) {
    io.to(roomName).emit(event, data);
}

function startGame(roomName) {
    let room = rooms[roomName];
    room.gameState = createInitialState();
    room.gameState.round = (room.gameState.round || 1);
    
    let deck = createDeck();
    deck.forEach((c, i) => room.players[i % 4].hand.push(c));
    room.players.forEach(p => sortHand(p.hand));
    room.gameState.turn = Math.floor(Math.random() * 4);
    
    broadcastState(room);
    checkBotTurn(room);
}

function sortHand(hand) {
    hand.sort((a,b) => {
        if(a.str !== b.str) return a.str - b.str;
        return a.suit.charCodeAt(0) - b.suit.charCodeAt(0);
    });
}

function broadcastState(room) {
    let playerNames = room.players.map(p => p.name);
    let scores = room.players.map(p => p.score);

    room.players.forEach((p, i) => {
        if(p.isBot) return;
        let opponentCounts = room.players.map(pl => pl.hand.length);
        io.to(p.id).emit('updateState', {
            myHand: p.hand,
            field: room.gameState.field,
            turn: room.gameState.turn,
            counts: opponentCounts,
            names: playerNames,
            scores: scores,
            info: {
                rev: room.gameState.isRevolution,
                eleven: room.gameState.isElevenBack,
                bind: room.gameState.isBind,
                round: room.gameState.round,
                maxRounds: MAX_ROUNDS
            },
            winners: room.gameState.winners,
            fouled: room.gameState.fouled,
            lastPlayer: room.gameState.lastPlayer
        });
    });
}

/* --- Bot ロジック --- */
function checkBotTurn(room) {
    let gs = room.gameState;
    let pIdx = gs.turn;
    let player = room.players[pIdx];
    let finished = [...gs.winners, ...gs.fouled];

    if (finished.includes(pIdx) || !player.isBot) return;
    if (!rooms[room.id]) return;

    setTimeout(() => {
        try {
            botPlaySmart(room, pIdx);
        } catch(e) {
            console.error("Bot Error", e);
            processPass(room, pIdx);
        }
    }, 1000);
}

function botPlaySmart(room, pIdx) {
    let player = room.players[pIdx];
    let hand = player.hand;
    let gs = room.gameState;
    let candidates = [];

    // 出せるカードを探す
    if (gs.field.length === 0) {
        // 親番: ペア
        let groups = {};
        hand.forEach(c => {
            if (c.isJoker) return;
            if (!groups[c.num]) groups[c.num] = [];
            groups[c.num].push(c);
        });
        for (let num in groups) {
            if (groups[num].length >= 2) candidates.push({ cards: groups[num], type: 'pair', str: groups[num][0].str });
        }
        // 親番: 単騎
        hand.forEach(c => candidates.push({ cards: [c], type: 'single', str: (c.isJoker ? 14 : c.str) }));
    } else {
        // 子番: 場に出せるかチェック
        if (gs.lastPlayType === 'single') {
            hand.forEach(c => {
                if (checkRules([c], gs).ok) candidates.push({ cards: [c], type: 'single', str: (c.isJoker ? 14 : c.str) });
            });
        } else if (gs.lastPlayType === 'pair') {
            let groups = {};
            hand.forEach(c => { if(c.isJoker)return; if(!groups[c.num]) groups[c.num]=[]; groups[c.num].push(c); });
            for (let num in groups) {
                if(groups[num].length === gs.field.length && checkRules(groups[num], gs).ok) {
                    candidates.push({ cards: groups[num], type: 'pair', str: groups[num][0].str });
                }
            }
        }
    }

    // 弱い順に出す
    if (candidates.length > 0) {
        if (!gs.isRevolution) candidates.sort((a, b) => a.str - b.str);
        else candidates.sort((a, b) => b.str - a.str);
        
        let best = candidates[0];
        processPlay(room, pIdx, best.cards, best.type);
    } else {
        processPass(room, pIdx);
    }
}

/* --- ゲーム進行 --- */
function processPlay(room, pIdx, cards, type) {
    let gs = room.gameState;
    let msg = "";

    // ★修正: 縛り(Bind)判定
    // 既に場にカードがある場合、スートを比較する
    if (gs.field.length > 0) {
        let prevSuits = gs.field.map(c => c.suit).sort().join('');
        let newSuits = cards.map(c => c.suit).sort().join('');
        if (prevSuits === newSuits && !cards[0].isJoker && !gs.field[0].isJoker) {
            if (!gs.isBind) {
                gs.isBind = true; // ここで縛りON
                msg = "縛り！ ";
            }
        }
        // ※一度縛りになったら、場が流れるまで解除されない（ルールによるが一般的に）
        // ここでは「マークが違えば縛りは発生しない」が、checkRulesで弾かれるため、出せた時点で縛り継続なら同じマークのはず
    } else {
        // 場が空なら縛りはリセットされているはずだが念のため
        gs.isBind = false;
    }

    // カード更新
    gs.field = cards;
    gs.lastPlayType = type;
    gs.lastPlayer = pIdx;
    gs.passed = [];
    room.players[pIdx].hand = room.players[pIdx].hand.filter(c => !cards.some(target => target.id === c.id));

    // あがり・革命・特殊役判定
    if (room.players[pIdx].hand.length === 0) {
        gs.winners.push(pIdx);
        msg += `${room.players[pIdx].name} あがり！`;
    } else {
         if (cards.length >= 4) { gs.isRevolution = !gs.isRevolution; msg += "革命！ "; }
         if (cards.some(c => c.num === 8) && type !== 'stairs') { msg += "8切り！"; resetField(gs); gs.turn = pIdx; }
         if (cards.some(c => c.num === 11) && type !== 'stairs') { gs.isElevenBack = true; msg += "11バック！ "; }
    }
    
    if(msg) broadcastToRoom(room.id, 'msg', msg);

    // 次のターンへ
    let isEight = (cards.some(c => c.num === 8) && type !== 'stairs');
    if (isEight) {
        if (room.players[pIdx].hand.length === 0) nextTurn(gs);
        else { resetField(gs); gs.turn = pIdx; } // 8切りは親維持
    } else {
        nextTurn(gs);
    }
    
    checkGameEnd(room);
    broadcastState(room);
    checkBotTurn(room);
}

function processPass(room, pIdx) {
    let gs = room.gameState;
    if (!gs.passed.includes(pIdx)) gs.passed.push(pIdx);
    
    let active = 4 - gs.winners.length - gs.fouled.length;
    if (active <= 1) { checkGameEnd(room); return; }

    if (gs.passed.length >= active - 1) {
        broadcastToRoom(room.id, 'msg', "場が流れました");
        resetField(gs); // ここで縛りもリセット
        
        gs.turn = gs.lastPlayer;
        let finished = [...gs.winners, ...gs.fouled];
        if (finished.includes(gs.turn)) nextTurn(gs);
    } else {
        nextTurn(gs);
    }
    broadcastState(room);
    checkBotTurn(room);
}

function nextTurn(gs) {
    let loop = 0;
    let finished = [...gs.winners, ...gs.fouled];
    do { gs.turn = (gs.turn + 1) % 4; loop++; } while (finished.includes(gs.turn) && loop < 10);
}

function resetField(gs) {
    gs.field = [];
    gs.passed = [];
    gs.lastPlayType = "single";
    gs.isBind = false; // 縛り解除
    gs.isElevenBack = false;
    gs.lastPlayer = -1;
}

function checkGameEnd(room) {
    let gs = room.gameState;
    let finishedCount = gs.winners.length + gs.fouled.length;
    if (finishedCount >= 3) {
        for(let i=0; i<4; i++) {
            if(!gs.winners.includes(i) && !gs.fouled.includes(i)) gs.winners.push(i);
        }
        gs.winners.forEach((pIdx, rank) => { room.players[pIdx].score += SCORES[rank]; });

        let resultData = room.players.map((p, i) => {
            let rank = gs.winners.indexOf(i);
            let pt = (rank >= 0) ? SCORES[rank] : 0;
            if(gs.fouled.includes(i)) pt = -2;
            return { name: p.name, score: p.score, roundPt: pt };
        });

        broadcastToRoom(room.id, 'roundResult', { results: resultData, round: gs.round, isFinal: gs.round >= MAX_ROUNDS });

        if (gs.round < MAX_ROUNDS) {
            gs.round++;
            setTimeout(() => {
                let r = rooms[room.id];
                if(r) {
                    let nextGs = createInitialState();
                    nextGs.round = gs.round;
                    r.gameState = nextGs;
                    let deck = createDeck();
                    r.players.forEach(p=>p.hand = []);
                    deck.forEach((c, i) => r.players[i % 4].hand.push(c));
                    r.players.forEach(p => sortHand(p.hand));
                    r.gameState.turn = Math.floor(Math.random() * 4);
                    broadcastState(r);
                    checkBotTurn(r);
                }
            }, 5000);
        } else {
             broadcastToRoom(room.id, 'msg', "全ラウンド終了！");
        }
    }
}

function checkRules(cards, gs) {
    if(cards.length === 0) return {ok:false};
    let type = "unknown";
    let normals = cards.filter(c=>!c.isJoker);
    let jokers = cards.length - normals.length;
    
    let isPair = false;
    if(normals.length > 0) { if(normals.every(c => c.num === normals[0].num)) isPair = true; } else isPair = true;

    let isStairs = false;
    if(cards.length >= 3) {
        let baseSuit = normals.length > 0 ? normals[0].suit : null;
        if(normals.every(c => c.suit === baseSuit)) {
            let sorted = [...cards].sort((a,b) => {
                let na = (a.num<=2 && a.num>0) ? a.num+13 : a.num;
                let nb = (b.num<=2 && b.num>0) ? b.num+13 : b.num;
                if(a.isJoker) return 99; return na - nb;
            });
            let nOnly = sorted.filter(c=>!c.isJoker);
            if(nOnly.length === 0) isStairs = true;
            else {
                let holes = 0;
                for(let i=0; i<nOnly.length-1; i++) {
                    let v1 = (nOnly[i].num<=2)?nOnly[i].num+13 : nOnly[i].num;
                    let v2 = (nOnly[i+1].num<=2)?nOnly[i+1].num+13 : nOnly[i+1].num;
                    holes += (v2 - v1 - 1);
                }
                if(holes >= 0 && holes <= jokers) isStairs = true;
            }
        }
    }
    if(isStairs) type = "stairs"; else if(isPair) type = (cards.length === 1) ? "single" : "pair"; else return {ok:false};

    if(gs.field.length > 0) {
        // スペ3返し
        if(gs.field.length === 1 && gs.field[0].isJoker) {
            if(cards.length === 1 && cards[0].suit === '♠' && cards[0].num === 3) return {ok:true, type:'single', isSpe3:true};
            // ジョーカー最強（革命時除く）
            let rev = (gs.isRevolution !== gs.isElevenBack);
            if(rev) return {ok:false}; 
        }
        if(cards.length !== gs.field.length) return {ok:false};
        if(gs.lastPlayType !== type) return {ok:false};
        
        // 縛りチェック (ルール適用)
        if(gs.isBind) {
            let fSuits = gs.field.map(c=>c.suit).sort().join('');
            let cSuits = cards.map(c=>c.suit).sort().join('');
            if(type === 'stairs') {
                 if(gs.field[0].suit !== cards[0].suit && !gs.field[0].isJoker && !cards[0].isJoker) return {ok:false};
            } else if(fSuits !== cSuits) return {ok:false};
        }

        let fieldStr = getStrength(gs.field, type);
        let myStr = getStrength(cards, type);
        let rev = (gs.isRevolution !== gs.isElevenBack);
        if(rev) { if(myStr >= fieldStr) return {ok:false}; } else { if(myStr <= fieldStr) return {ok:false}; }
    }
    return {ok:true, type:type};
}

function getStrength(cards, type) {
    if(cards.length===1 && cards[0].isJoker) return 14;
    if(type === 'stairs') { let sorted = [...cards].sort((a,b) => a.str - b.str); return sorted[0].str; }
    let n = cards.find(c=>!c.isJoker); return n ? n.str : 13;
}

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });