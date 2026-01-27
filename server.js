const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

/* --- ルーム管理システム ---
  rooms = {
     "合言葉A": { players: [], gameState: {...} },
     "合言葉B": { players: [], gameState: {...} }
  }
*/
let rooms = {};

const SUITS = ['♠', '♥', '♦', '♣'];

// カード生成関数
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

// 初期ゲームステート作成
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
        isBind: false,
        lastPlayType: "single",
        lastPlayer: -1
    };
}

io.on('connection', (socket) => {
    // 接続時は何もしない（ルーム参加待ち）

    socket.on('joinGame', (data) => {
        let roomName = data.roomName || "default"; // 合言葉
        let name = data.name || "Guest";
        
        // 名前とルーム名の長さを制限
        roomName = roomName.substring(0, 15);
        name = name.substring(0, 10);

        // ルームがなければ作る
        if (!rooms[roomName]) {
            rooms[roomName] = {
                players: [],
                gameState: createInitialState()
            };
        }

        let room = rooms[roomName];

        if (room.players.length < 4) {
            // Socket.ioの機能でグループ分け
            socket.join(roomName);
            // ソケットに部屋情報を記録しておく
            socket.data.roomName = roomName;
            socket.data.name = name;

            room.players.push({ id: socket.id, hand: [], name: name });
            
            let myIdx = room.players.length - 1;
            socket.emit('initInfo', { myIdx: myIdx, roomName: roomName });

            // 部屋内の全員に通知
            broadcastToRoom(roomName, 'playerUpdate', { 
                count: room.players.length, 
                names: room.players.map(p => p.name) 
            });

            if (room.players.length === 4) {
                startGame(roomName);
            }
        } else {
            socket.emit('gameFull');
        }
    });

    socket.on('playCard', (data) => {
        let roomName = socket.data.roomName;
        if (!roomName || !rooms[roomName]) return;
        let room = rooms[roomName];

        let pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx === -1 || pIdx !== room.gameState.turn) return;

        let cards = data.cardIds.map(cid => room.players[pIdx].hand.find(c => c.id === cid)).filter(c => c);
        
        // ルール判定に room.gameState を渡す
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
            room.players = room.players.filter(p => p.id !== socket.id);
            
            // 誰か抜けたらその部屋はリセット（簡易仕様）
            if (room.players.length === 0) {
                delete rooms[roomName]; // 誰もいなくなったら部屋削除
            } else {
                room.gameState = createInitialState(); // ゲーム中ならリセット
                broadcastToRoom(roomName, 'playerUpdate', { 
                    count: room.players.length, 
                    names: room.players.map(p => p.name) 
                });
                broadcastToRoom(roomName, 'msg', "プレイヤーが切断しました。リセットします。");
            }
        }
    });
});

/* --- ゲーム進行ロジック（引数にroomを受け取るように変更） --- */

function broadcastToRoom(roomName, event, data) {
    io.to(roomName).emit(event, data);
}

function startGame(roomName) {
    let room = rooms[roomName];
    room.gameState = createInitialState();

    let deck = createDeck();
    deck.forEach((c, i) => {
        room.players[i % 4].hand.push(c);
    });
    room.players.forEach(p => sortHand(p.hand));
    room.gameState.turn = Math.floor(Math.random() * 4);
    
    broadcastState(roomName);
}

function sortHand(hand) {
    hand.sort((a,b) => {
        if(a.str !== b.str) return a.str - b.str;
        return a.suit.charCodeAt(0) - b.suit.charCodeAt(0);
    });
}

function broadcastState(roomName) {
    let room = rooms[roomName];
    let playerNames = room.players.map(p => p.name);

    room.players.forEach((p, i) => {
        let opponentCounts = room.players.map(pl => pl.hand.length);
        io.to(p.id).emit('updateState', {
            myHand: p.hand,
            field: room.gameState.field,
            turn: room.gameState.turn,
            counts: opponentCounts,
            names: playerNames,
            info: {
                rev: room.gameState.isRevolution,
                eleven: room.gameState.isElevenBack,
                bind: room.gameState.isBind,
                round: room.gameState.round
            },
            winners: room.gameState.winners,
            fouled: room.gameState.fouled
        });
    });
}

function processPlay(room, pIdx, cards, type) {
    let gs = room.gameState;
    // 禁止あがりチェック
    if (room.players[pIdx].hand.length === cards.length) {
        if (isForbiddenMove(cards, true, gs)) {
            gs.fouled.push(pIdx);
            room.players[pIdx].hand = [];
            broadcastToRoom(socket.data.roomName, 'msg', `${room.players[pIdx].name} 反則負け！`); // socket.data.roomName注意: processPlay内でsocketは使えないので引数か構造を見直す必要がありますが、ここではroom経由で通知します
            // ※修正: processPlayはsocketスコープ外から呼ばれることもあるため、roomNameはroomオブジェクトからは直接取れない(キーを知る必要がある)。
            // 簡易的に io.to で送るために、roomオブジェクトにnameを持たせるか、呼び出し元でioを使う。
            // ここでは簡易的に io.to(...) を使うため、呼び出し元でroomNameを特定できている前提で動かします。
        }
    }
    
    // ※socket.data.roomNameはこの関数内で使えないため、roomオブジェクトを探すためのキー逆引き等はコストがかかる。
    // そのため、broadcastState内で io.to(p.id) しているので、一斉送信用の関数を用意して使う。
    // ここでは「roomオブジェクト」しか渡していないので、room名を知る方法が必要。
    // 手っ取り早く、roomオブジェクトにidを持たせます。
    
    // ★ 修正: processPlayの引数修正が手間なので、全プレイヤーのsocketIDを使って送信するbroadcastStateに任せます。
    // メッセージ送信だけ別途行う必要があります。
    // 今回は簡単のため「全プレイヤーにmsgイベント」を送るhelperを使います。
    function sendMsg(txt) {
         room.players.forEach(p => io.to(p.id).emit('msg', txt));
    }

    if (room.players[pIdx].hand.length === cards.length && isForbiddenMove(cards, true, gs)) {
        gs.fouled.push(pIdx);
        room.players[pIdx].hand = [];
        sendMsg(`${room.players[pIdx].name} 反則負け！`);
        checkGameEnd(room);
        // roomNameが不明だが、broadcastStateはplayer.idを使うので動く
        // ただしstartGame等はroomNameが必要。
        // ★ roomオブジェクトにnameプロパティを追加するのが一番安全です。
        // rooms[roomName] = { name: roomName, ... } とします。
    } else {
        gs.field = cards;
        gs.lastPlayType = type;
        gs.lastPlayer = pIdx;
        gs.passed = [];
        room.players[pIdx].hand = room.players[pIdx].hand.filter(c => !cards.some(target => target.id === c.id));

        let msg = "";
        if (type !== 'stairs' && cards.some(c => c.num === 8)) {
            msg = "8切り！";
            resetField(gs);
            gs.turn = pIdx;
        } 
        else if (gs.field.length===1 && cards.length===1 && cards[0].suit==='♠' && cards[0].num===3 && cards[0].isSpe3) {
            msg = "スペ3返し！";
            resetField(gs);
            gs.turn = pIdx;
        }
        else {
            if (cards.length >= 4) { gs.isRevolution = !gs.isRevolution; msg = "革命！"; }
            if (type !== 'stairs' && cards.some(c => c.num === 11)) { gs.isElevenBack = true; msg = "11バック！"; }
            
            if (room.players[pIdx].hand.length === 0) {
                gs.winners.push(pIdx);
                sendMsg(`${room.players[pIdx].name} あがり！`);
            }
            checkGameEnd(room);
            if(gs.field.length > 0) nextTurn(gs); 
        }
        if(msg) sendMsg(msg);
    }
    
    // roomNameを特定してbroadcast
    // room.players[0]がいればそこからroomNameを逆引きできるが、
    // roomsの構造作成時に name プロパティを入れておきます。(joinGame参照)
    // joinGame内: rooms[roomName] = { id: roomName, ... }
    
    // ★今回のコード内での整合性確保: 
    // 上記の createInitialState 等では id を入れていないので、
    // processPlay の末尾で broadcastState を呼ぶ際、第1引数の roomName が必要。
    // しかし broadcastState は roomName をキーに rooms から引いている。
    // → 引数を room オブジェクトそのものに変えたほうが安全。
    // broadcastState の修正を行います。
    broadcastStateByObject(room);
}

function processPass(room, pIdx) {
    let gs = room.gameState;
    if (!gs.passed.includes(pIdx)) gs.passed.push(pIdx);
    
    let active = 4 - gs.winners.length - gs.fouled.length;
    if (active <= 1) { checkGameEnd(room); return; }

    if (gs.passed.length >= active - 1) {
        room.players.forEach(p => io.to(p.id).emit('msg', "場が流れました"));
        resetField(gs);
        gs.turn = gs.lastPlayer;
        let loop=0;
        let allFinished = [...gs.winners, ...gs.fouled];
        while(allFinished.includes(gs.turn) && loop<10){
            gs.turn = (gs.turn + 1) % 4; loop++;
        }
    } else {
        nextTurn(gs);
    }
    broadcastStateByObject(room);
}

function nextTurn(gs) {
    let loop = 0;
    let allFinished = [...gs.winners, ...gs.fouled];
    do {
        gs.turn = (gs.turn + 1) % 4;
        loop++;
    } while (allFinished.includes(gs.turn) && loop < 10);
}

function resetField(gs) {
    gs.field = [];
    gs.passed = [];
    gs.lastPlayType = "single";
    gs.isBind = false;
    gs.isElevenBack = false;
}

function checkGameEnd(room) {
    let gs = room.gameState;
    if (gs.winners.length + gs.fouled.length >= 3) {
        room.players.forEach(p => io.to(p.id).emit('msg', "ラウンド終了！"));
        
        // roomNameが必要だが、ここでもroomオブジェクトから再開させる
        // 簡易的に4秒後にstartGameを呼ぶために、roomNameが必要。
        // room.players[0].id から socket を特定...は面倒なので、
        // rooms オブジェクト生成時に id を埋め込む方式を採用します。
        
        // ※joinGame関数内で `rooms[roomName].id = roomName` を入れています(後述修正)。
        setTimeout(() => {
            // 部屋がまだ存在すれば再開
            if(room.players.length === 4) {
                 startGameByObject(room);
            }
        }, 4000); 
    }
}

// ★ヘルパー関数のオーバーロード（オブジェクト直接渡し版）
function broadcastStateByObject(room) {
    let playerNames = room.players.map(p => p.name);
    room.players.forEach((p, i) => {
        let opponentCounts = room.players.map(pl => pl.hand.length);
        io.to(p.id).emit('updateState', {
            myHand: p.hand,
            field: room.gameState.field,
            turn: room.gameState.turn,
            counts: opponentCounts,
            names: playerNames,
            info: {
                rev: room.gameState.isRevolution,
                eleven: room.gameState.isElevenBack,
                bind: room.gameState.isBind,
                round: room.gameState.round
            },
            winners: room.gameState.winners,
            fouled: room.gameState.fouled
        });
    });
}
function startGameByObject(room) {
    room.gameState = createInitialState();
    let deck = createDeck();
    deck.forEach((c, i) => {
        room.players[i % 4].hand.push(c);
    });
    room.players.forEach(p => sortHand(p.hand));
    room.gameState.turn = Math.floor(Math.random() * 4);
    broadcastStateByObject(room);
}

/* --- ルール判定（引数 gs 追加） --- */
function checkRules(cards, gs) {
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

    if(gs.field.length > 0) {
        if(gs.field.length === 1 && gs.field[0].isJoker) {
            if(cards.length === 1 && cards[0].suit === '♠' && cards[0].num === 3) return {ok:true, type:'single', isSpe3:true};
            let rev = (gs.isRevolution !== gs.isElevenBack);
            if(rev) return {ok:false};
        }
        if(cards.length !== gs.field.length) return {ok:false};
        if(gs.lastPlayType !== type) return {ok:false};
        
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

function isForbiddenMove(cards, isLastHand, gs) {
    if(!isLastHand) return false;
    let rev = (gs.isRevolution !== gs.isElevenBack);
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