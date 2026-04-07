'use client';

import { blockTypeLabel } from './planner-utils.mjs';

export function PlannerBlockSidepanel({
  selectedBlock,
  onClose,
  onReleaseVehicleBlock,
  onOpenBlockVehicle
}) {
  if (!selectedBlock) return null;

  return (
    <aside className="planner-sidepanel glass card">
      <div className="row-between" style={{ marginBottom: 6 }}>
        <h3>Vehicle Block</h3>
        <button onClick={onClose}>Close</button>
      </div>
      <div style={{ fontWeight: 700 }}>{selectedBlock.vehicle?.internalNumber || 'Vehicle'}</div>
      <div className="label">{selectedBlock.vehicle?.year || ''} {selectedBlock.vehicle?.make || ''} {selectedBlock.vehicle?.model || ''}</div>
      <div className="label">Type: {blockTypeLabel(selectedBlock.block.blockType)}</div>
      <div className="label">Blocked from: {new Date(selectedBlock.block.blockedFrom).toLocaleString()}</div>
      <div className="label">Available again: {new Date(selectedBlock.block.availableFrom).toLocaleString()}</div>
      <div className="label">Reason: {selectedBlock.block.reason || 'Legacy contract migration hold'}</div>
      {selectedBlock.block.notes ? <div className="label" style={{ marginBottom: 8 }}>Notes: {selectedBlock.block.notes}</div> : null}
      <div className="label" style={{ marginBottom: 8 }}>Source: {selectedBlock.block.sourceType || 'MANUAL'}</div>
      <div style={{ display: 'grid', gap: 8 }}>
        <button type="button" onClick={() => onReleaseVehicleBlock(selectedBlock.block.id)}>Release Block</button>
        <button type="button" className="button-subtle" onClick={() => onOpenBlockVehicle(selectedBlock.vehicle)}>Edit Block</button>
      </div>
    </aside>
  );
}
