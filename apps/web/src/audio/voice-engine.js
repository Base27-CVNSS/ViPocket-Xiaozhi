const INPUT_SAMPLE_RATE = 16000;
const DEFAULT_OUTPUT_SAMPLE_RATE = 24000;
const FRAME_DURATION_MS = 60;

export class VoiceEngine {
  constructor({ bitrate = 24000, onPacket, onLevel, onError } = {}) {
    this.bitrate = bitrate;
    this.onPacket = onPacket || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onError = onError || (() => {});
    this.context = null;
    this.stream = null;
    this.source = null;
    this.captureNode = null;
    this.encoder = null;
    this.decoder = null;
    this.captureTimestampUs = 0;
    this.decodeTimestampUs = 0;
    this.outputSampleRate = DEFAULT_OUTPUT_SAMPLE_RATE;
    this.playbackCursor = 0;
    this.sources = new Set();
  }

  static async capabilities() {
    const secure = window.isSecureContext;
    const worklet = Boolean(window.AudioWorkletNode && window.AudioContext);
    const webCodecs = Boolean(window.AudioEncoder && window.AudioDecoder && window.AudioData && window.EncodedAudioChunk);
    let opus = false;

    if (webCodecs) {
      try {
        const [enc, dec] = await Promise.all([
          AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: INPUT_SAMPLE_RATE, numberOfChannels: 1, bitrate: 24000 }),
          AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: DEFAULT_OUTPUT_SAMPLE_RATE, numberOfChannels: 1 })
        ]);
        opus = Boolean(enc.supported && dec.supported);
      } catch {
        opus = false;
      }
    }

    return { secure, worklet, webCodecs, opus };
  }

  async ensureContext() {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.playbackCursor = this.context.currentTime;
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  async configureEncoder() {
    if (this.encoder && this.encoder.state !== 'closed') return;
    const config = {
      codec: 'opus',
      sampleRate: INPUT_SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: Number(this.bitrate)
    };
    const support = await AudioEncoder.isConfigSupported(config);
    if (!support.supported) throw new Error('This browser cannot encode raw Opus with WebCodecs.');

    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const packet = new Uint8Array(chunk.byteLength);
        chunk.copyTo(packet);
        this.onPacket(packet.buffer);
      },
      error: (error) => this.onError(error)
    });
    this.encoder.configure(config);
  }

  configureDecoder(sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE) {
    this.outputSampleRate = Number(sampleRate) || DEFAULT_OUTPUT_SAMPLE_RATE;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = new AudioDecoder({
      output: (audioData) => this.playAudioData(audioData),
      error: (error) => this.onError(error)
    });
    this.decoder.configure({
      codec: 'opus',
      sampleRate: this.outputSampleRate,
      numberOfChannels: 1
    });
    this.decodeTimestampUs = 0;
  }

  async startCapture() {
    if (this.stream) return;
    await this.ensureContext();
    await this.configureEncoder();
    await this.context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    this.source = this.context.createMediaStreamSource(this.stream);
    this.captureNode = new AudioWorkletNode(this.context, 'vipocket-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: {
        targetSampleRate: INPUT_SAMPLE_RATE,
        frameDurationMs: FRAME_DURATION_MS
      }
    });
    this.captureNode.port.onmessage = (event) => {
      if (event.data?.type !== 'frame') return;
      const frame = event.data.frame;
      let peak = 0;
      for (let index = 0; index < frame.length; index += 1) peak = Math.max(peak, Math.abs(frame[index]));
      this.onLevel(Math.min(1, peak * 2.2));
      this.encodeFrame(frame);
    };
    this.source.connect(this.captureNode);
  }

  encodeFrame(frame) {
    if (!this.encoder || this.encoder.state !== 'configured') return;
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: INPUT_SAMPLE_RATE,
      numberOfFrames: frame.length,
      numberOfChannels: 1,
      timestamp: this.captureTimestampUs,
      data: frame.buffer
    });
    this.captureTimestampUs += FRAME_DURATION_MS * 1000;
    this.encoder.encode(audioData);
    audioData.close();
  }

  async stopCapture() {
    this.captureNode?.port.postMessage({ type: 'stop' });
    try { this.source?.disconnect(); } catch {}
    try { this.captureNode?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.source = null;
    this.captureNode = null;
    this.onLevel(0);
    if (this.encoder?.state === 'configured') await this.encoder.flush().catch(() => {});
    this.captureTimestampUs = 0;
  }

  decode(packet) {
    if (!this.decoder || this.decoder.state !== 'configured') this.configureDecoder(this.outputSampleRate);
    const chunk = new EncodedAudioChunk({
      type: 'key',
      timestamp: this.decodeTimestampUs,
      data: packet
    });
    this.decodeTimestampUs += FRAME_DURATION_MS * 1000;
    this.decoder.decode(chunk);
  }

  async playAudioData(audioData) {
    await this.ensureContext();
    const frames = audioData.numberOfFrames;
    const channel = new Float32Array(frames);
    audioData.copyTo(channel, { planeIndex: 0, format: 'f32-planar' });
    const audioBuffer = this.context.createBuffer(1, frames, audioData.sampleRate);
    audioBuffer.copyToChannel(channel, 0);
    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.context.destination);
    this.playbackCursor = Math.max(this.context.currentTime + 0.02, this.playbackCursor);
    source.start(this.playbackCursor);
    this.playbackCursor += audioBuffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    audioData.close();
  }

  interruptPlayback() {
    for (const source of this.sources) {
      try { source.stop(); } catch {}
    }
    this.sources.clear();
    if (this.decoder?.state === 'configured') this.decoder.reset();
    this.playbackCursor = this.context?.currentTime || 0;
    this.decodeTimestampUs = 0;
  }

  async close() {
    await this.stopCapture();
    this.interruptPlayback();
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }
}
