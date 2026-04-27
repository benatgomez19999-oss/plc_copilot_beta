import type { ResolvedSymbol, SymbolKind } from './types.js';

export class SymbolTable {
  private readonly byPirName = new Map<string, ResolvedSymbol>();

  constructor(public readonly stationId?: string) {}

  add(sym: ResolvedSymbol): void {
    this.byPirName.set(sym.pirName, sym);
  }

  resolve(pirName: string): ResolvedSymbol | null {
    return this.byPirName.get(pirName) ?? null;
  }

  has(pirName: string): boolean {
    return this.byPirName.has(pirName);
  }

  all(): ResolvedSymbol[] {
    return Array.from(this.byPirName.values());
  }

  filter(kind: SymbolKind): ResolvedSymbol[] {
    return this.all().filter((s) => s.kind === kind);
  }

  size(): number {
    return this.byPirName.size;
  }
}
