'use client';

export function PlannerHoldModal({
  showBlockVehicle,
  selectedVehicleForBlock,
  blockForm,
  setBlockForm,
  saveVehicleBlock,
  onClose
}) {
  if (!showBlockVehicle || !selectedVehicleForBlock) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rent-modal glass" onClick={(event) => event.stopPropagation()}>
        <h3>Temporary Hold | {selectedVehicleForBlock.internalNumber}</h3>
        <form className="stack" onSubmit={saveVehicleBlock}>
          <div className="grid2">
            <select value={blockForm.blockType} onChange={(event) => setBlockForm({ ...blockForm, blockType: event.target.value })}>
              <option value="MIGRATION_HOLD">Migration Hold</option>
              <option value="MAINTENANCE_HOLD">Maintenance Hold</option>
              <option value="WASH_HOLD">Wash Buffer Hold</option>
              <option value="OUT_OF_SERVICE_HOLD">Out Of Service Hold</option>
            </select>
            <div />
          </div>
          <div className="grid2">
            <div className="stack">
              <label className="label">Blocked From</label>
              <input type="datetime-local" value={blockForm.blockedFrom} onChange={(event) => setBlockForm({ ...blockForm, blockedFrom: event.target.value })} />
            </div>
            <div className="stack">
              <label className="label">Available Again*</label>
              <input required type="datetime-local" value={blockForm.availableFrom} onChange={(event) => setBlockForm({ ...blockForm, availableFrom: event.target.value })} />
            </div>
          </div>
          <input placeholder="Reason (migration hold, legacy contract, etc.)" value={blockForm.reason} onChange={(event) => setBlockForm({ ...blockForm, reason: event.target.value })} />
          <textarea rows={4} placeholder="Notes" value={blockForm.notes} onChange={(event) => setBlockForm({ ...blockForm, notes: event.target.value })} />
          <div className="surface-note">Migration holds count as already committed fleet. Maintenance and out-of-service holds remove units from rentable service until the selected release date.</div>
          <div className="row-between">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit">Save Hold</button>
          </div>
        </form>
      </div>
    </div>
  );
}
