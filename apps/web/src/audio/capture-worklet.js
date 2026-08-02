class ViPocketCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetSampleRate || 16000;
    this.frameDurationMs = options.processorOptions?.frameDurationMs || 60;
    this.targetFrameSize = Math.round(this.targetRate * this.frameDurationMs / 1000);
    this.buffer = [];
    this.readPosition = 0;
    this.previousSample = 0;
    this.ratio = sampleRate / this.targetRate;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'stop') this.running = false;
    };
  }

  resample(input) {
    if (sampleRate === this.targetRate) return Array.from(input);
    const output = [];
    let position = this.readPosition;
    while (position < input.length) {
      const leftIndex = Math.floor(position);
      const rightIndex = Math.min(leftIndex + 1, input.length - 1);
      const fraction = position - leftIndex;
      const left = leftIndex >= 0 ? input[leftIndex] : this.previousSample;
      const right = input[rightIndex];
      output.push(left + (right - left) * fraction);
      position += this.ratio;
    }
    this.readPosition = position - input.length;
    this.previousSample = input[input.length - 1] || this.previousSample;
    return output;
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    this.buffer.push(...this.resample(input));
    while (this.buffer.length >= this.targetFrameSize) {
      const frame = new Float32Array(this.buffer.splice(0, this.targetFrameSize));
      this.port.postMessage({ type: 'frame', frame }, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor('vipocket-capture', ViPocketCaptureProcessor);
