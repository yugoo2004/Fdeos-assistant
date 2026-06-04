import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const audioPath = process.argv[2];
const modelDir = process.env.SHERPA_ONNX_MODEL_DIR;
const sherpaModulePath = process.env.SHERPA_ONNX_NODE_MODULE;

if (!audioPath || !existsSync(audioPath)) {
  console.error(`Missing WAV file: ${audioPath || ""}`);
  process.exit(2);
}
if (!modelDir || !existsSync(modelDir)) {
  console.error(`Missing SHERPA_ONNX_MODEL_DIR: ${modelDir || ""}`);
  process.exit(2);
}
if (!sherpaModulePath || !existsSync(sherpaModulePath)) {
  console.error(`Missing sherpa-onnx-node module: ${sherpaModulePath || ""}`);
  process.exit(2);
}

const sherpaModule = await import(sherpaModulePath);
const sherpa = sherpaModule.default ?? sherpaModule;

const required = {
  encoder: ["encoder.int8.onnx", "encoder-epoch-99-avg-1.onnx"],
  decoder: ["decoder.int8.onnx", "decoder-epoch-99-avg-1.onnx"],
  joiner: ["joiner.int8.onnx", "joiner-epoch-99-avg-1.onnx"],
  tokens: ["tokens.txt"],
  model: ["model.int8.onnx", "model.onnx"],
};

function pickFile(candidates) {
  for (const candidate of candidates) {
    const path = join(modelDir, candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  return "";
}

const model = {
  encoder: pickFile(required.encoder),
  decoder: pickFile(required.decoder),
  joiner: pickFile(required.joiner),
  tokens: pickFile(required.tokens),
  singleModel: pickFile(required.model),
};

if (!model.tokens) {
  console.error(`Missing tokens in ${modelDir}`);
  process.exit(2);
}

function readPcm16Wav(path) {
  const buffer = readFileSync(path);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Only RIFF/WAVE input is supported");
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (channels !== 1 || bitsPerSample !== 16) {
    throw new Error(`Expected mono 16-bit WAV, got channels=${channels}, bits=${bitsPerSample}`);
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const dataStart = offset + 8;
      const sampleCount = Math.floor(chunkSize / 2);
      const samples = new Float32Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        samples[index] = buffer.readInt16LE(dataStart + index * 2) / 32768;
      }
      return { samples, sampleRate, durationMs: Math.round((sampleCount / sampleRate) * 1000) };
    }
    offset += 8 + chunkSize;
  }
  throw new Error("Missing WAV data chunk");
}

const { samples, sampleRate, durationMs } = readPcm16Wav(audioPath);

let recognizer;
let stream;

if (model.encoder && model.decoder && model.joiner) {
  recognizer = new sherpa.OnlineRecognizer({
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: model.encoder,
        decoder: model.decoder,
        joiner: model.joiner,
      },
      tokens: model.tokens,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
    maxActivePaths: 4,
    enableEndpoint: 0,
  });
  stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  stream.inputFinished();
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
  }
} else if (model.encoder && model.decoder) {
  recognizer = new sherpa.OnlineRecognizer({
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      paraformer: {
        encoder: model.encoder,
        decoder: model.decoder,
      },
      tokens: model.tokens,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
    maxActivePaths: 4,
    enableEndpoint: 0,
  });
  stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  stream.inputFinished();
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
  }
} else if (model.singleModel) {
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      paraformer: {
        model: model.singleModel,
      },
      tokens: model.tokens,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
  });
  stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  recognizer.decode(stream);
} else {
  console.error(`Unsupported sherpa-onnx ASR model directory: ${modelDir}`);
  process.exit(2);
}

const result = recognizer.getResult(stream);
console.log(JSON.stringify({ text: result.text || "", duration_ms: durationMs }));
stream.free?.();
recognizer.free?.();
