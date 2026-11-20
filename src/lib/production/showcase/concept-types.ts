/** Shared structural types for showcase modules (kept free of Prisma). */
import type { ProductionBrief } from "../engine";
import type { ProductUnderstanding } from "./types";

export type { ProductionBrief };
export type ProductUnderstandingLike = Pick<ProductUnderstanding, "identity" | "purpose" | "mainBenefit" | "capabilities"> & { problem?: string };
