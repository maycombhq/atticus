import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * The server side of RFC 6455, just what live events need: the handshake, text frames out,
 * ping/pong and close in. Written here because the repo takes no new runtime dependencies and
 * the UI only listens on this socket.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

/** One frame from the server (servers never mask). */
export function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export class Socket {
  private buf = Buffer.alloc(0);
  closed = false;

  constructor(
    private readonly sock: Duplex,
    private readonly onClose: (s: Socket) => void,
  ) {
    sock.on("data", (d: Buffer) => this.read(d));
    sock.on("close", () => this.end());
    sock.on("error", () => this.end());
  }

  send(text: string): void {
    if (!this.closed) this.sock.write(frame(0x1, Buffer.from(text, "utf8")));
  }

  close(): void {
    if (this.closed) return;
    this.sock.write(frame(0x8, Buffer.alloc(0)));
    this.sock.end();
    this.end();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }

  /** Client frames are masked; only control frames matter to us. */
  private read(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const opcode = this.buf[0]! & 0x0f;
      const masked = (this.buf[1]! & 0x80) !== 0;
      let len = this.buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked)
        for (let i = 0; i < payload.length; i++) payload[i]! ^= this.buf[maskOff + (i % 4)]!;
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) this.sock.write(frame(0xa, payload));
    }
  }
}

/** Finish the handshake; the caller has already checked the path, token and origin. */
export function upgrade(
  req: IncomingMessage,
  sock: Duplex,
  onClose: (s: Socket) => void,
): Socket | undefined {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return undefined;
  }
  sock.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "",
      "",
    ].join("\r\n"),
  );
  return new Socket(sock, onClose);
}
