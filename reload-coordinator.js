const STATE_KEY = "akuBridgeReloadCoordinatorV1";
const MAX_OPERATIONS = 128;

function blocked(reason = "reload_busy") {
  const error = new Error("AkuBridge reload requires settled operations and verified surface cleanup.");
  error.code = reason;
  error.stage = "reload";
  return error;
}

// This coordinator fences admission, not resource ownership. It never closes a
// tab or grants an old journal record authority in a new extension incarnation.
export function createReloadCoordinator({ storage, inspect, reload }) {
  let active = 0, fenced = false, uncertain = false, action = null, committing = false;
  let writes = Promise.resolve();
  const ready = Promise.resolve().then(async () => {
    if (!storage) throw blocked("reload_state_unavailable");
    const previous = (await storage.get(STATE_KEY))[STATE_KEY];
    if (previous === undefined) return;
    if (!previous || !Number.isInteger(previous.active) || previous.active < 0 ||
        previous.active > MAX_OPERATIONS || typeof previous.fenced !== "boolean") {
      throw blocked("reload_state_unavailable");
    }
    // A worker restart cannot prove that an interrupted browser operation or
    // reload handshake settled. Only an extension lifecycle reset clears this.
    if (previous.active || previous.fenced || previous.uncertain !== false) uncertain = true;
  }).catch(() => { uncertain = true; });
  function save() {
    const value = { active, fenced, uncertain };
    writes = writes.then(() => storage.set({ [STATE_KEY]: value }));
    return writes.catch(() => { uncertain = true; throw blocked("reload_state_unavailable"); });
  }
  async function enter() {
    if (fenced) throw blocked();
    await ready;
    if (fenced || uncertain || active >= MAX_OPERATIONS) throw blocked();
    active++;
    try { await save(); }
    catch (error) { active--; throw error; }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      active--;
      await save();
    };
  }
  return Object.freeze({
    async run(operation) {
      const leave = await enter();
      let failed = false;
      try { return await operation(); }
      catch (error) { failed = true; throw error; }
      finally {
        try { await leave(); }
        catch (error) { if (!failed) throw error; }
      }
    },
    async prepare(actionId) {
      if (fenced || typeof actionId !== "string" || !actionId || actionId.length > 256) throw blocked();
      // Reserve synchronously, before storage, inventory or other awaits.
      fenced = true;
      action = actionId;
      try {
        await ready;
        if (active || uncertain) throw blocked();
        await save();
        await inspect();
      } catch (error) {
        action = null;
        fenced = false;
        await save();
        throw error;
      }
    },
    async cancel(actionId) {
      if (action !== actionId || committing) return;
      action = null;
      fenced = false;
      await save();
    },
    async complete(actionId, acknowledge = () => {}) {
      await ready;
      if (!fenced || action !== actionId || active || uncertain || committing) throw blocked();
      committing = true;
      try {
        await save();
        acknowledge();
        reload();
      } catch (error) {
        committing = false;
        action = null;
        fenced = false;
        await save();
        throw error;
      }
    },
  });
}
