export const PROTOCOL_VERSION = 1;

export function createHello({ features = {}, inputSampleRate = 16000, frameDuration = 60 } = {}) {
  return {
    type: 'hello',
    version: PROTOCOL_VERSION,
    features: {
      mcp: true,
      aec: true,
      barge_in_v2: true,
      audio_pts: true,
      ...features
    },
    transport: 'websocket',
    audio_params: {
      format: 'opus',
      sample_rate: inputSampleRate,
      channels: 1,
      frame_duration: frameDuration
    }
  };
}

export function createListen(sessionId, state, mode = 'manual') {
  return { session_id: sessionId, type: 'listen', state, mode };
}

export function createAbort(sessionId, reason = 'user_interruption') {
  return { session_id: sessionId, type: 'abort', reason };
}

export function parseServerMessage(raw) {
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
    throw new Error('Malformed Xiaozhi JSON message.');
  }
  return payload;
}
