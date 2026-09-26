import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { CACHE_SCHEMAS, type CacheSchemaName } from './json-schema';
import type {
  BudgetDocument,
  ChunkDocument,
  ContextDocument,
  ExtractionDocument,
  Manifest,
  ResearchDocument,
  SourceMapDocument,
} from './types';

export interface SchemaTypeMap {
  manifest: Manifest;
  extractionDocument: ExtractionDocument;
  sourceMapDocument: SourceMapDocument;
  contextDocument: ContextDocument;
  researchDocument: ResearchDocument;
  budgetDocument: BudgetDocument;
  chunkDocument: ChunkDocument;
}

export interface ValidationFailure {
  ok: false;
  errors: string[];
}
export interface ValidationSuccess<T> {
  ok: true;
  value: T;
}
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const compiled = new Map<CacheSchemaName, ValidateFunction>();

function getValidator(name: CacheSchemaName): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    v = ajv.compile(CACHE_SCHEMAS[name]);
    compiled.set(name, v);
  }
  return v;
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
}

/** 캐시 파일 JSON을 스키마로 검증한다. 통과하면 타입이 붙은 값을 돌려준다. */
export function validateCacheDocument<N extends CacheSchemaName>(
  name: N,
  data: unknown,
): ValidationResult<SchemaTypeMap[N]> {
  const v = getValidator(name);
  if (v(data)) return { ok: true, value: data as SchemaTypeMap[N] };
  return { ok: false, errors: formatAjvErrors(v.errors) };
}
