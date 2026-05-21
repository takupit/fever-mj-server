// ============================================================
// src/socket/events.js
// Socket.IO で使うイベント名の定数集約。
// 送受信の両側で同じ文字列を使うため、ここで一元管理する。
// 設計書「5. WebSocketイベント定義」に対応。
// ============================================================

module.exports = {
  // クライアント → サーバー
  C2S: {
    LOBBY_CREATE_ROOM: 'lobby:create-room',
    LOBBY_JOIN_ROOM: 'lobby:join-room',
    LOBBY_LEAVE_ROOM: 'lobby:leave-room',
    LOBBY_CREATE_SOLO_ROOM: 'lobby:create-solo-room', // 1人＋CPU2 練習用
    GAME_DISCARD: 'game:discard',
    GAME_PON: 'game:pon',
    GAME_KAN: 'game:kan',
    GAME_REACH: 'game:reach',
    GAME_TSUMO: 'game:tsumo',
    GAME_RON: 'game:ron',
    GAME_KITA: 'game:kita',
    GAME_KITA_PON: 'game:kita-pon',
    GAME_KITA_KAN: 'game:kita-kan',
    GAME_SKIP: 'game:skip',
    GAME_NEXT_HAND: 'game:next-hand',
    GAME_RECONNECT: 'game:reconnect',
  },
  // サーバー → クライアント
  S2C: {
    LOBBY_ROOM_CREATED: 'lobby:room-created',
    LOBBY_ROOM_JOINED: 'lobby:room-joined',
    LOBBY_PLAYER_JOINED: 'lobby:player-joined',
    LOBBY_PLAYER_LEFT: 'lobby:player-left',
    LOBBY_ERROR: 'lobby:error',
    GAME_START: 'game:start',
    GAME_STATE_UPDATE: 'game:state-update',
    GAME_YOUR_HAND: 'game:your-hand',
    GAME_YOUR_TURN: 'game:your-turn',
    GAME_WAITING_CLAIM: 'game:waiting-claim',
    GAME_ACTION_RESULT: 'game:action-result',
    GAME_AGARI: 'game:agari',
    GAME_RYUKYOKU: 'game:ryukyoku',
    GAME_HAND_END: 'game:hand-end',
    GAME_GAME_END: 'game:game-end',
    GAME_TOBI: 'game:tobi',
    GAME_PLAYER_DISCONNECTED: 'game:player-disconnected',
    GAME_PLAYER_RECONNECTED: 'game:player-reconnected',
    GAME_CPU_TAKEOVER: 'game:cpu-takeover',
  },
};
