const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Render等の環境変数ポートに対応
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

/* --- ゲームステート --- */
let players = []; 
// playersの中身: { id: "socketid", hand: [], name: "入力された名前" }

let gameState = {
    round: 1,
    turn: 0,
    field: [],
    passed: [],
    winners: [],
    fouled: [],
    isRevolution: false,
    isElevenBack: false,
    isBind: false,
    lastPlayType: "single",
    lastPlayer: -1
};

/* --- 定数・カード生成 --- */
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

/* --- 通信処理 --- */
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    // ※接続時はまだ参加させない

    // ■ 名前を受け取って参加登録
    socket.on('joinGame', (data) => {
        if (players.length < 4) {
            let name = data.name || `Guest${players.length + 1}`;
            // 20文字以内にカット
            name = name.substring(0, 12);

            players.push({ id: socket.id, hand: [], name: name });
            let myIdx = players.length - 1;
            
            // 本人にインデックス通知
            socket.emit('initInfo', { myIdx: myIdx });
            
            // 全員に参加状況（人数と名前リスト）を通知
            io.emit('playerUpdate', { 
                count: players.length, 
                names: players.map(p => p.name) 
            });

            if (players.length === 4) {
                startGame();
            }
        } else {
            socket.emit('gameFull');
        }
    });

    socket.on('playCard', (data) => {
        let pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx === -1 || pIdx !== gameState.turn) return;

        let cards = data.cardIds.map(cid => players[pIdx].hand.find(c => c.id === cid)).filter(c => c);
        let check = checkRules(cards);
        if (check.ok) processPlay(pIdx, cards, check.type);
    });

    socket.on('pass', () => {
        let pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx === -1 || pIdx !== gameState.turn) return;
        processPass(pIdx);
    });

    socket.on('disconnect', () => {
        console.log('Disconnect:', socket.id);
        // 切断したプレイヤーを削除
        players = players.filter(p => p.id !== socket.id);
        io.emit('playerUpdate', { 
            count: players.length, 
            names: players.map(p => p.name) 
        });
        // 誰か抜けたらゲームリセット
        if(gameState.round > 0) gameState.round = 1; 
    });
});

/* --- ゲーム進行ロジック --- */
function startGame() {
    gameState.field = [];
    gameState.passed = [];
    gameState.winners = [];
    gameState.fouled = [];
    gameState.isRevolution = false;
    gameState.isElevenBack = false;
    gameState.isBind = false;
    gameState.lastPlayType = "single";
    gameState.lastPlayer = -1;

    let deck = createDeck();
    deck.forEach((c, i) => {
        players[i % 4].hand.push(c);
    });
    players.forEach(p => sortHand(p.hand));
    gameState.turn = Math.floor(Math.random() * 4);
    
    broadcastState();
}

function sortHand(hand) {
    hand.sort((a,b) => {
        if(a.str !== b.str) return a.str - b.str;
        return a.suit.charCodeAt(0) - b.suit.charCodeAt(0);
    });
}

function broadcastState() {
    // 全員の名前リストを作成
    let playerNames = players.map(p => p.name);

    players.forEach((p, i) => {
        let opponentCounts = players.map(pl => pl.hand.length);
        io.to(p.id).emit('updateState', {
            myHand: p.hand,
            field: gameState.field,
            turn: gameState.turn,
            counts: opponentCounts,
            names: playerNames, // 名前リストを送る
            info: {
                rev: gameState.isRevolution,
                eleven: gameState.isElevenBack,
                bind: gameState.isBind,
                round: gameState.round
            },
            winners: gameState.winners,
            fouled: gameState.fouled
        });
    });
}

function processPlay(pIdx, cards, type) {
    // 禁止あがりチェック
    if (players[pIdx].hand.length === cards.length) {
        if (isForbiddenMove(cards, true)) {
            gameState.fouled.push(pIdx);
            players[pIdx].hand = [];
            io.emit('msg', `${players[pIdx].name} 反則負け！`);
            checkGameEnd();
            broadcastState();
            return;
        }
    }

    gameState.field = cards;
    gameState.lastPlayType = type;
    gameState.lastPlayer = pIdx;
    gameState.passed = [];
    players[pIdx].hand = players[pIdx].hand.filter(c => !cards.some(target => target.id === c.id));

    // 特殊効果
    let msg = "";
    if (type !== 'stairs' && cards.some(c => c.num === 8)) {
        msg = "8切り！";
        resetField();
        gameState.turn = pIdx;
    } 
    else if (gameState.field.length===1 && cards.length===1 && cards[0].suit==='♠' && cards[0].num===3 && cards[0].isSpe3) {
         msg = "スペ3返し！";
         resetField();
         gameState.turn = pIdx;
    }
    else {
        if (cards.length >= 4) { gameState.isRevolution = !gameState.isRevolution; msg = "革命！"; }
        if (type !== 'stairs' && cards.some(c => c.num === 11)) { gameState.isElevenBack = true; msg = "11バック！"; }
        
        if (players[pIdx].hand.length === 0) {
            gameState.winners.push(pIdx);
            io.emit('msg', `${players[pIdx].name} あがり！`);
        }
        checkGameEnd();
        if(gameState.field.length > 0) nextTurn(); 
    }
    if(msg) io.emit('msg', msg);
    
    broadcastState();
}

function processPass(pIdx) {
    if (!gameState.passed.includes(pIdx)) gameState.passed.push(pIdx);
    
    let active = 4 - gameState.winners.length - gameState.fouled.length;
    // バグ防止: activeが1人以下の時は即終了判定
    if (active <= 1) { checkGameEnd(); return; }

    if (gameState.passed.length >= active - 1) {
        io.emit('msg', "場が流れました");
        resetField();
        gameState.turn = gameState.lastPlayer;
        let loop=0;
        let allFinished = [...gameState.winners, ...gameState.fouled];
        while(allFinished.includes(gameState.turn) && loop<10){
            gameState.turn = (gameState.turn + 1) % 4; loop++;
        }
    } else {
        nextTurn();
    }
    broadcastState();
}

function nextTurn() {
    let loop = 0;
    let allFinished = [...gameState.winners, ...gameState.fouled];
    do {
        gameState.turn = (gameState.turn + 1) % 4;
        loop++;
    } while (allFinished.includes(gameState.turn) && loop < 10);
}

function resetField() {
    gameState.field = [];
    gameState.passed = [];
    gameState.lastPlayType = "single";
    gameState.isBind = false;
    gameState.isElevenBack = false;
}

function checkGameEnd() {
    if (gameState.winners.length + gameState.fouled.length >= 3) {
        io.emit('msg', "ラウンド終了！");
        setTimeout(startGame, 4000); 
    }
}

/* --- ルール判定 --- */
function checkRules(cards) {
    if(cards.length === 0) return {ok:false};
    let type = "unknown";
    let jokers = cards.filter(c=>c.isJoker).length;
    let normals = cards.filter(c=>!c.isJoker);
    
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

    if(gameState.field.length > 0) {
        if(gameState.field.length === 1 && gameState.field[0].isJoker) {
            if(cards.length === 1 && cards[0].suit === '♠' && cards[0].num === 3) return {ok:true, type:'single', isSpe3:true};
            let rev = (gameState.isRevolution !== gameState.isElevenBack);
            if(rev) return {ok:false};
        }
        if(cards.length !== gameState.field.length) return {ok:false};
        if(gameState.lastPlayType !== type) return {ok:false};
        
        // 縛り判定
        if(gameState.isBind) {
            let fSuits = gameState.field.map(c=>c.suit).sort().join('');
            let cSuits = cards.map(c=>c.suit).sort().join('');
            if(type === 'stairs') {
                 if(gameState.field[0].suit !== cards[0].suit && !gameState.field[0].isJoker && !cards[0].isJoker) return {ok:false};
            } else if(fSuits !== cSuits) return {ok:false};
        }

        let fieldStr = getStrength(gameState.field, type);
        let myStr = getStrength(cards, type);
        let rev = (gameState.isRevolution !== gameState.isElevenBack);
        if(rev) { if(myStr >= fieldStr) return {ok:false}; } else { if(myStr <= fieldStr) return {ok:false}; }
    }
    return {ok:true, type:type};
}

function getStrength(cards, type) {
    if(cards.length===1 && cards[0].isJoker) return 14;
    if(type === 'stairs') { let sorted = [...cards].sort((a,b) => a.str - b.str); return sorted[0].str; }
    let n = cards.find(c=>!c.isJoker); return n ? n.str : 13;
}

function isForbiddenMove(cards, isLastHand) {
    if(!isLastHand) return false;
    let rev = (gameState.isRevolution !== gameState.isElevenBack);
    if(cards.length > 1) {
        if(cards.length === 2 && cards[0].isJoker && cards[1].isJoker) return true;
        if(cards.length === 2) {
            let hasJoker = cards.some(c => c.isJoker);
            let other = cards.find(c => !c.isJoker);
            if(hasJoker && other) {
                if(other.num === 8) return true;
                if(!rev && other.num === 2) return true;
                if(rev && other.num === 3) return true;
            }
        }
        return false; 
    }
    let c = cards[0];
    if(c.isJoker) return true; if(c.num === 8) return true;
    if(!rev && c.num === 2) return true; if(rev && c.num === 3) return true;
    return false;
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});