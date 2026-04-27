export class SymbolTable {
    stationId;
    byPirName = new Map();
    constructor(stationId) {
        this.stationId = stationId;
    }
    add(sym) {
        this.byPirName.set(sym.pirName, sym);
    }
    resolve(pirName) {
        return this.byPirName.get(pirName) ?? null;
    }
    has(pirName) {
        return this.byPirName.has(pirName);
    }
    all() {
        return Array.from(this.byPirName.values());
    }
    filter(kind) {
        return this.all().filter((s) => s.kind === kind);
    }
    size() {
        return this.byPirName.size;
    }
}
