'use client';

import { useState } from 'react';
import { api } from '../../lib/client';
import { activeAvailabilityBlock, toLocalDateTimeInput } from './planner-utils.mjs';

export function usePlannerPanels({ token, setVehicles, onMessage }) {
  const [selectedReservation, setSelectedReservation] = useState(null);
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [showBlockVehicle, setShowBlockVehicle] = useState(false);
  const [selectedVehicleForBlock, setSelectedVehicleForBlock] = useState(null);
  const [blockForm, setBlockForm] = useState({
    blockType: 'MIGRATION_HOLD',
    blockedFrom: toLocalDateTimeInput(new Date()),
    availableFrom: '',
    reason: '',
    notes: ''
  });

  const closeSelectedReservation = () => setSelectedReservation(null);
  const closeSelectedBlock = () => setSelectedBlock(null);
  const closeBlockVehicle = () => {
    setShowBlockVehicle(false);
    setSelectedVehicleForBlock(null);
  };

  const upsertVehicleBlockInState = (vehicleId, block) => {
    if (!vehicleId || !block?.id) return;
    setVehicles((current) => current.map((vehicle) => {
      if (vehicle.id !== vehicleId) return vehicle;
      const existing = Array.isArray(vehicle.availabilityBlocks) ? vehicle.availabilityBlocks : [];
      const nextBlocks = existing.some((row) => row.id === block.id)
        ? existing.map((row) => (row.id === block.id ? { ...row, ...block } : row))
        : [...existing, block];
      return { ...vehicle, availabilityBlocks: nextBlocks };
    }));
    setSelectedBlock((current) => (
      current?.block?.id === block.id
        ? { ...current, block: { ...current.block, ...block } }
        : current
    ));
  };

  const syncUpdatedReservation = (updatedReservation) => {
    if (!updatedReservation?.id) return;
    setSelectedReservation((current) => (
      current?.reservation?.id === updatedReservation.id
        ? { ...current, reservation: { ...current.reservation, ...updatedReservation }, overbooked: updatedReservation?.vehicleId ? false : current.overbooked }
        : current
    ));
  };

  const openBlockVehicle = (vehicle) => {
    const activeBlock = activeAvailabilityBlock(vehicle);
    const baseStart = activeBlock?.blockedFrom ? toLocalDateTimeInput(activeBlock.blockedFrom) : toLocalDateTimeInput(new Date());
    setSelectedReservation(null);
    setSelectedBlock(null);
    setSelectedVehicleForBlock(vehicle);
    setBlockForm({
      blockType: activeBlock?.blockType || 'MIGRATION_HOLD',
      blockedFrom: baseStart,
      availableFrom: activeBlock?.availableFrom ? toLocalDateTimeInput(activeBlock.availableFrom) : '',
      reason: activeBlock?.reason || '',
      notes: activeBlock?.notes || ''
    });
    setShowBlockVehicle(true);
  };

  const saveVehicleBlock = async (event) => {
    event.preventDefault();
    if (!selectedVehicleForBlock) return;
    try {
      const createdBlock = await api(`/api/vehicles/${selectedVehicleForBlock.id}/availability-blocks`, {
        method: 'POST',
        body: JSON.stringify(blockForm)
      }, token);
      upsertVehicleBlockInState(selectedVehicleForBlock.id, createdBlock);
      onMessage?.(`Vehicle ${selectedVehicleForBlock.internalNumber} blocked until ${new Date(blockForm.availableFrom).toLocaleString()}`);
      closeBlockVehicle();
    } catch (error) {
      onMessage?.(error.message);
    }
  };

  const releaseVehicleBlock = async (blockId) => {
    try {
      const releasedBlock = await api(`/api/vehicles/availability-blocks/${blockId}/release`, {
        method: 'POST',
        body: JSON.stringify({})
      }, token);
      upsertVehicleBlockInState(releasedBlock?.vehicleId || selectedBlock?.vehicle?.id || selectedVehicleForBlock?.id || null, releasedBlock);
      onMessage?.('Vehicle block released');
      setSelectedBlock(null);
      closeBlockVehicle();
    } catch (error) {
      onMessage?.(error.message);
    }
  };

  const selectReservation = (payload) => {
    setSelectedBlock(null);
    setSelectedReservation(payload);
  };

  const selectBlock = (payload) => {
    setSelectedReservation(null);
    setSelectedBlock(payload);
  };

  return {
    selectedReservation,
    selectedBlock,
    showBlockVehicle,
    selectedVehicleForBlock,
    blockForm,
    setBlockForm,
    setSelectedReservation,
    setSelectedBlock,
    selectReservation,
    selectBlock,
    closeSelectedReservation,
    closeSelectedBlock,
    closeBlockVehicle,
    syncUpdatedReservation,
    openBlockVehicle,
    saveVehicleBlock,
    releaseVehicleBlock
  };
}
