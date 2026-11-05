// Undo / redo for the layout editor.
//
// `snapshot()` returns a plain JSON-able state; `apply(state)` makes the board
// match it (re-creating stacks if needed) and may return an id map
// {oldStackId: newStackId} so older snapshots keep pointing at the right stacks.

export function createHistory({ snapshot, apply, limit = 80, onChange = () => {} }) {
  let past = [];
  let present = null;
  let future = [];
  let busy = false;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function remap(map) {
    if (!map || !Object.keys(map).length) return;
    const fix = (s) => {
      if (!s) return;
      for (const st of s.stacks || []) if (map[st.id] != null) st.id = map[st.id];
      for (const p of s.pages || []) for (const n of p.layout || []) if (map[n.stack_id] != null) n.stack_id = map[n.stack_id];
    };
    past.forEach(fix); future.forEach(fix); fix(present);
  }

  async function go(from, to) {
    if (busy || !from.length) return false;
    busy = true;
    to.push(present);
    present = from.pop();
    try {
      remap(await apply(structuredClone(present)));
    } finally {
      busy = false;
      onChange();
    }
    return true;
  }

  return {
    reset() { present = snapshot(); past = []; future = []; onChange(); },
    record() {
      if (busy) return;
      const s = snapshot();
      if (present && same(s, present)) return;
      if (present) past.push(present);
      if (past.length > limit) past.shift();
      present = s;
      future = [];
      onChange();
    },
    undo: () => go(past, future),
    redo: () => go(future, past),
    get canUndo() { return past.length > 0 && !busy; },
    get canRedo() { return future.length > 0 && !busy; },
    get busy() { return busy; },
  };
}
