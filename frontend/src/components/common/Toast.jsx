import React, { useEffect } from 'react'
import { IconCheck, IconX } from './Icons'

export function Toast({ msg, type, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className={`toast toast-${type}`}>
      {type === 'success' ? <IconCheck size={16} /> : <IconX size={16} />}
      <span>{msg}</span>
    </div>
  );
}
