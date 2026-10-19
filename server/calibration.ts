import { readFile } from 'node:fs/promises';
import type { Distribution } from '../shared/protection';

export const CALIBRATION_FILE = 'reports/calibration.json';
export type Calibration = { generatedAt: string; source: string; samples: number; distributions: Distribution[] };

/** The latest `npm run calibrate` report, if one exists. */
export async function loadCalibration(path = CALIBRATION_FILE): Promise<Calibration | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
