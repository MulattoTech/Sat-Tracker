export interface BottleRow {
  id: string; time: string; amount: number | null; offeredAmount: number | null;
  unitAbbr: string | null; bottleType: string | null; formulaKcalOz: number | null;
  formulaName: string | null; bottleLabel: string | null; notes: string | null;
  sourceCaregiverName: string | null; caretakerName: string | null; updatedAt: string;
}
export interface BottlePayload {
  time: string; amount: number | null; offeredAmount: number | null;
  unitAbbr: string; bottleType: string; formulaKcalOz: number | null;
  formulaName: string | null; bottleLabel: string | null; notes: string | null;
  sourceCaregiverName?: string | null;
}
export interface JournalData {
  babyId: string; day: string; timeZone: string; canManage: boolean; targetMl: number | null;
  totals: { dailyMl: number; rollingMl: number; dailyCount: number; rollingCount: number;
    unknownVolumes: number; targetMl: number | null; remainingMl: number | null; progress: number | null };
  rows: BottleRow[];
}
export type JournalRequest = <T>(url: string, body: unknown, method?: string) => Promise<T>;
