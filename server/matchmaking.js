import { GameRoom } from "./room.js";

/**
 * Puts a guest into the one waiting match, or opens a new one.
 * A user is only ever seated in a single room.
 */
export class Matchmaker {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.waiting = null;
  }

  roomForUser(userId) {
    for (const room of this.rooms.values()) {
      if (room.status === "dead") continue;
      if (room.seatForUser(userId)) return room;
    }
    return null;
  }

  remove(room) {
    this.rooms.delete(room.id);
    if (this.waiting === room) this.waiting = null;
  }

  connect(socket) {
    const userId = socket.data.user.id;
    const existing = this.roomForUser(userId);
    if (existing) {
      existing.remember(socket);
      existing.attach(socket);
      return;
    }
    const session = socket.request.session;
    if (session && session.gameId) {
      session.gameId = null;
      session.save(() => {});
    }
    this.enqueue(socket);
  }

  enqueue(socket) {
    const waiting = this.waiting;
    if (
      waiting
      && waiting.status === "waiting"
      && !waiting.seat.b.userId
      && !waiting.seat.b.bot
    ) {
      if (waiting.seat.a.userId === socket.data.user.id) {
        waiting.attach(socket);
        return;
      }
      this.waiting = null;
      waiting.seatHuman("b", socket);
      waiting.startCountdown();
      return;
    }
    const room = new GameRoom(this, this.io);
    this.rooms.set(room.id, room);
    this.waiting = room;
    room.seatHuman("a", socket);
  }

  playBot(socket) {
    const room = this.rooms.get(socket.data.gameId);
    if (!room || room.status !== "waiting") return;
    if (socket.data.seatKey !== "a") return;
    if (room.seat.b.userId || room.seat.b.bot) return;
    room.seatBot("b");
    this.waiting = null;
    room.startCountdown();
  }

  command(socket, cmd) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.command(socket, cmd);
  }

  concede(socket) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.concede(socket);
  }

  leave(socket) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.leave(socket);
  }

  disconnect(socket) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.disconnect(socket);
  }
}
