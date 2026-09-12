import { FileChannel, FILE_CHANNEL_PROTOCOL, type FileChannelOptions } from "./channel.js";
import { ChangeSignal, FileAccessError, abortable, boundedNumber, type Disposable, type FileDescriptor, type FileRequest, type FileSource, type ResolvedFile } from "./types.js";

export interface FilePeerOptions extends FileChannelOptions {
  /** No default STUN/TURN servers. The application chooses any network infrastructure. */
  rtcConfiguration?: RTCConfiguration;
  /** Time allowed for offer/answer exchange and connection. Default 30 seconds. */
  connectionTimeoutMs?: number;
}
export type FilePeerDescription = { type: "offer" | "answer"; sdp: string };

/** A WebRTC file endpoint. Exchange descriptions over your application's authenticated signaling. */
export class FilePeer implements FileSource, Disposable {
  readonly ready: Promise<void>;
  private complete!: () => void;
  private reject!: (error: FileAccessError) => void;
  private changed = new ChangeSignal();
  readonly onChange = this.changed.subscribe;
  private connection: RTCPeerConnection;
  private lifetime = new AbortController();
  private channel?: FileChannel;
  private channelSubscription?: Disposable;
  private phase: "new" | "offering" | "answering" | "connected" | "closed" = "new";
  private answered = false;
  private timeout: number;
  private deadline?: ReturnType<typeof setTimeout>;
  private channelOptions: FileChannelOptions;

  constructor(options: FilePeerOptions = {}) {
    if (typeof RTCPeerConnection === "undefined") throw new FileAccessError("UNAVAILABLE");
    this.timeout = boundedNumber(options.connectionTimeoutMs, 30_000, 100, 300_000);
    // Validate limits before allocating a connection.
    boundedNumber(options.timeoutMs, 30_000, 100, 300_000);
    boundedNumber(options.maxPreviewBytes, 16 * 1024 ** 2, 1024, 128 * 1024 ** 2);
    boundedNumber(options.maxDownloadBytes, 128 * 1024 ** 2, 1024, 1024 ** 3);
    boundedNumber(options.maxConcurrentTransfers, 4, 1, 16);
    this.channelOptions = { files: options.files, timeoutMs: options.timeoutMs, maxPreviewBytes: options.maxPreviewBytes, maxDownloadBytes: options.maxDownloadBytes, maxConcurrentTransfers: options.maxConcurrentTransfers };
    this.connection = new RTCPeerConnection(options.rtcConfiguration ?? { iceServers: [] });
    this.ready = new Promise((resolve, reject) => { this.complete = resolve; this.reject = reject; });
    void this.ready.catch(() => {});
    this.connection.addEventListener("datachannel", this.dataChannel);
    this.connection.addEventListener("connectionstatechange", this.connectionChanged);
  }
  get state(): "new" | "connecting" | "connected" | "closed" {
    return this.phase === "offering" || this.phase === "answering" ? "connecting" : this.phase;
  }
  has(reference: string): boolean { return this.channel?.has(reference) ?? false; }
  list(): readonly FileDescriptor[] { return this.channel?.list() ?? []; }
  resolve(reference: string, request: FileRequest): Promise<ResolvedFile | null> {
    if (request.signal.aborted) return Promise.reject(new FileAccessError("ABORTED"));
    return this.channel?.resolve(reference, request) ?? Promise.resolve(null);
  }
  private start(phase: "offering" | "answering"): void {
    if (this.phase !== "new") throw new FileAccessError("PROTOCOL");
    this.phase = phase;
    this.deadline = setTimeout(() => this.close(new FileAccessError("TIMEOUT")), this.timeout);
  }
  private dataChannel = (event: RTCDataChannelEvent): void => {
    if (this.phase !== "answering" || this.channel || event.channel.protocol !== FILE_CHANNEL_PROTOCOL) { event.channel.close(); return; }
    try { this.attach(event.channel); } catch { event.channel.close(); this.close(new FileAccessError("PROTOCOL")); }
  };
  private connectionChanged = (): void => {
    if (this.connection.connectionState === "failed" || this.connection.connectionState === "closed") this.close(new FileAccessError("DISCONNECTED"));
  };
  private attach(channel: RTCDataChannel): void {
    const stream = new FileChannel(channel, this.channelOptions); this.channel = stream;
    this.channelSubscription = stream.onChange(() => this.changed.fire());
    void stream.ready.then(() => {
      if (this.phase === "closed") return;
      clearTimeout(this.deadline); this.phase = "connected"; this.complete();
    }, error => this.close(error instanceof FileAccessError ? error : new FileAccessError("DISCONNECTED")));
    channel.addEventListener("close", () => this.close(new FileAccessError("DISCONNECTED")), { once: true });
  }
  private description(value: FilePeerDescription, expected: "offer" | "answer"): RTCSessionDescriptionInit {
    if (!value || value.type !== expected || typeof value.sdp !== "string" || value.sdp.length < 1 || value.sdp.length > 65_536) throw new FileAccessError("PROTOCOL");
    return { type: expected, sdp: value.sdp };
  }
  private async localDescription(type: "offer" | "answer"): Promise<FilePeerDescription> {
    const connection = this.connection;
    if (connection.iceGatheringState !== "complete") {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { connection.removeEventListener("icegatheringstatechange", check); this.lifetime.signal.removeEventListener("abort", abort); };
        const check = () => { if (connection.iceGatheringState === "complete") { cleanup(); resolve(); } };
        const abort = () => { cleanup(); reject(this.lifetime.signal.reason); };
        if (this.lifetime.signal.aborted) { abort(); return; }
        connection.addEventListener("icegatheringstatechange", check); this.lifetime.signal.addEventListener("abort", abort, { once: true }); check();
      });
    }
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason;
    const sdp = connection.localDescription?.sdp;
    if (!sdp || sdp.length > 65_536) throw new FileAccessError("PROTOCOL");
    return { type, sdp };
  }
  async createOffer(): Promise<FilePeerDescription> {
    this.start("offering");
    try {
      this.attach(this.connection.createDataChannel("shell-files", { ordered: true, protocol: FILE_CHANNEL_PROTOCOL }));
      const offer = await abortable(this.connection.createOffer(), this.lifetime.signal);
      await abortable(this.connection.setLocalDescription(offer), this.lifetime.signal);
      return await this.localDescription("offer");
    } catch (error) { const failure = error instanceof FileAccessError ? error : new FileAccessError("UNAVAILABLE"); this.close(failure); throw failure; }
  }
  async acceptOffer(offer: FilePeerDescription): Promise<FilePeerDescription> {
    const description = this.description(offer, "offer"); this.start("answering");
    try {
      await abortable(this.connection.setRemoteDescription(description), this.lifetime.signal);
      const answer = await abortable(this.connection.createAnswer(), this.lifetime.signal);
      await abortable(this.connection.setLocalDescription(answer), this.lifetime.signal);
      return await this.localDescription("answer");
    } catch (error) { const failure = error instanceof FileAccessError ? error : new FileAccessError("UNAVAILABLE"); this.close(failure); throw failure; }
  }
  async acceptAnswer(answer: FilePeerDescription): Promise<void> {
    const description = this.description(answer, "answer");
    if (this.phase !== "offering" || this.answered) throw new FileAccessError("PROTOCOL");
    this.answered = true;
    try { await abortable(this.connection.setRemoteDescription(description), this.lifetime.signal); }
    catch (error) { const failure = error instanceof FileAccessError ? error : new FileAccessError("UNAVAILABLE"); this.close(failure); throw failure; }
  }
  private close(error: FileAccessError): void {
    if (this.phase === "closed") return; this.phase = "closed";
    clearTimeout(this.deadline); this.lifetime.abort(error); this.channelSubscription?.dispose(); this.channel?.dispose();
    this.connection.removeEventListener("datachannel", this.dataChannel); this.connection.removeEventListener("connectionstatechange", this.connectionChanged);
    this.connection.close(); this.reject(error); this.changed.fire(); this.changed.dispose();
  }
  dispose(): void { this.close(new FileAccessError("DISCONNECTED")); }
}

export function createFilePeer(options: FilePeerOptions = {}): FilePeer { return new FilePeer(options); }
