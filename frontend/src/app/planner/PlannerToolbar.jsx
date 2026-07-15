'use client';

import { useTranslation } from 'react-i18next';
import { fmtDay } from './planner-utils.mjs';

// PL-1 toolbar row: Day/Week/Month segment, date nav + Today, location picker,
// class filter and plate/reservation search. (Tenant picker for SUPER_ADMIN.)
export function PlannerToolbar({
  isSuper,
  tenantRows,
  activeTenantId,
  setActiveTenantId,
  vehicleTypes,
  filterVehicleTypeId,
  setFilterVehicleTypeId,
  locations,
  filterLocationId,
  setFilterLocationId,
  view,
  setView,
  goToday,
  goPrev,
  goNext,
  rangeStart,
  rangeEnd,
  search,
  setSearch
}) {
  const { t } = useTranslation();
  const views = [
    { id: 'DAY', label: t('planner.viewDay') },
    { id: 'WEEK', label: t('planner.viewWeek') },
    { id: 'MONTH', label: t('planner.viewMonth') }
  ];
  const rangeLabel = view === 'DAY'
    ? fmtDay(rangeStart)
    : `${fmtDay(rangeStart)} – ${fmtDay(new Date(rangeEnd.getTime() - 24 * 60 * 60 * 1000))}`;

  return (
    <div className="pl-tbar">
      <div className="pl-seg" role="tablist" aria-label={t('planner.viewLabel')}>
        {views.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={view === option.id}
            className={view === option.id ? 'pl-seg-on' : ''}
            onClick={() => setView(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="pl-datenav">
        <button type="button" className="pl-arrow" onClick={goPrev} aria-label={t('common.previous')}>‹</button>
        <span className="pl-daterange">{rangeLabel}</span>
        <button type="button" className="pl-arrow" onClick={goNext} aria-label={t('common.next')}>›</button>
        <button type="button" className="pl-chip pl-chip-btn" onClick={goToday}>{t('planner.today')}</button>
      </div>
      {isSuper ? (
        <select
          className="pl-chip pl-chip-select"
          value={activeTenantId}
          onChange={(e) => setActiveTenantId(e.target.value)}
          aria-label={t('planner.tenant')}
        >
          <option value="">{t('planner.selectTenant')}</option>
          {tenantRows.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.name}{tenant.slug ? ` (${tenant.slug})` : ''}
            </option>
          ))}
        </select>
      ) : null}
      <select
        className="pl-chip pl-chip-select"
        value={filterLocationId}
        onChange={(e) => setFilterLocationId(e.target.value)}
        aria-label={t('planner.location')}
      >
        <option value="">📍 {t('planner.allLocations')}</option>
        {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
      </select>
      <select
        className="pl-chip pl-chip-select"
        value={filterVehicleTypeId}
        onChange={(e) => setFilterVehicleTypeId(e.target.value)}
        aria-label={t('planner.classLabel')}
      >
        <option value="">{t('planner.classAll')}</option>
        {vehicleTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
      </select>
      <input
        className="pl-chip pl-search"
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`🔍 ${t('planner.searchPlaceholder')}`}
        aria-label={t('planner.searchPlaceholder')}
      />
    </div>
  );
}
