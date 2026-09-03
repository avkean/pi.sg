import { readModel } from '../predict/models.mjs';
import { loadFixedGate } from './gate.mjs';

function readTable(path, entries, width) {
  const bytes = readModel(path);
  if (bytes.length !== entries * width)
    throw new Error('Invalid mixed model table');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const table =
    width === 4 ? new Uint32Array(entries) : new Uint16Array(entries);
  for (let index = 0; index < entries; index++)
    table[index] =
      width === 4
        ? view.getUint32(index * width, true)
        : view.getUint16(index * width, true);
  return table;
}

export function loadMixedGates() {
  const tables = {
    log2Q24: readTable('models/mixed-v1/log2-q24.le.bin', 65537, 4),
    tanhQ15: readTable('models/mixed-v1/tanh-q15.le.bin', 65537, 2)
  };
  const gates = {};
  for (const mode of ['tail', 'full']) {
    const model = JSON.parse(readModel(`models/mixed-v1/gate-${mode}.json`));
    if (model.scoringMode !== mode)
      throw new Error('Mixed model identity mismatch');
    gates[mode] = loadFixedGate(model, tables);
  }
  return gates;
}
