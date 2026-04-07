import { plannerService } from './planner.service.js';
import { settingsService } from '../settings/settings.service.js';

function escapeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function severityRank(value) {
  switch (String(value || '').toUpperCase()) {
    case 'HIGH': return 3;
    case 'MEDIUM': return 2;
    default: return 1;
  }
}

function inferRiskLevel(snapshot = {}) {
  const counters = snapshot?.counters || {};
  const shortage = Number(snapshot?.shortage?.totalCarsNeeded || 0);
  if (shortage > 0 || Number(counters.overbooked || 0) > 0) return 'HIGH';
  if (Number(counters.unassigned || 0) > 0 || Number(counters.inspectionAttention || 0) > 0 || Number(counters.telematicsAttention || 0) > 0) return 'MEDIUM';
  return 'LOW';
}

function buildVehicleHref(vehicleId) {
  return vehicleId ? `/vehicles/${vehicleId}` : null;
}

function buildReservationHref(reservationId) {
  return reservationId ? `/reservations/${reservationId}` : null;
}

function topInspectionAttention(snapshot = {}) {
  return (snapshot?.vehicles || [])
    .filter((vehicle) => String(vehicle?.operationalSignals?.inspection?.status || '').toUpperCase() === 'ATTENTION')
    .slice(0, 5)
    .map((vehicle) => ({
      id: `inspection-${vehicle.id}`,
      title: `Inspection review needed for unit ${vehicle.internalNumber || vehicle.id}`,
      detail: vehicle?.operationalSignals?.inspection?.summary || 'Latest inspection should be reviewed before the next assignment.',
      severity: 'MEDIUM',
      targetType: 'vehicle',
      targetId: vehicle.id,
      href: buildVehicleHref(vehicle.id)
    }));
}

function topDamageTriage(snapshot = {}) {
  return (snapshot?.vehicles || [])
    .filter((vehicle) => ['MEDIUM', 'HIGH'].includes(String(vehicle?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase()))
    .sort((left, right) => {
      const leftSeverity = String(left?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase();
      const rightSeverity = String(right?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase();
      return severityRank(rightSeverity === 'HIGH' ? 'HIGH' : 'MEDIUM') - severityRank(leftSeverity === 'HIGH' ? 'HIGH' : 'MEDIUM');
    })
    .slice(0, 5)
    .map((vehicle) => ({
      id: `damage-triage-${vehicle.id}`,
      title: `Damage triage review needed for unit ${vehicle.internalNumber || vehicle.id}`,
      detail: vehicle?.operationalSignals?.inspection?.damageTriage?.recommendedAction || vehicle?.operationalSignals?.inspection?.summary || 'Latest inspection needs damage review.',
      severity: String(vehicle?.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase() === 'HIGH' ? 'HIGH' : 'MEDIUM',
      targetType: 'vehicle',
      targetId: vehicle.id,
      href: buildVehicleHref(vehicle.id)
    }));
}

function topTelematicsAttention(snapshot = {}) {
  return (snapshot?.vehicles || [])
    .filter((vehicle) => (
      ['STALE', 'OFFLINE', 'NO_SIGNAL'].includes(String(vehicle?.operationalSignals?.telematics?.status || '').toUpperCase())
      || ['LOW', 'CRITICAL'].includes(String(vehicle?.operationalSignals?.telematics?.fuelStatus || '').toUpperCase())
      || String(vehicle?.operationalSignals?.telematics?.gpsStatus || '').toUpperCase() === 'MISSING'
    ))
    .slice(0, 5)
    .map((vehicle) => ({
      id: `telematics-${vehicle.id}`,
      title: `Telematics signal needs review for unit ${vehicle.internalNumber || vehicle.id}`,
      detail: vehicle?.operationalSignals?.telematics?.recommendedAction || vehicle?.operationalSignals?.telematics?.summary || 'Telematics feed has gone stale or is missing.',
      severity: ['CRITICAL', 'OFFLINE'].includes(String(vehicle?.operationalSignals?.telematics?.fuelStatus || vehicle?.operationalSignals?.telematics?.status || '').toUpperCase()) ? 'HIGH' : 'MEDIUM',
      targetType: 'vehicle',
      targetId: vehicle.id,
      href: buildVehicleHref(vehicle.id)
    }));
}

function topOverbooked(snapshot = {}) {
  return (snapshot?.overbookedReservations || [])
    .slice(0, 5)
    .map((reservation) => ({
      id: `overbooked-${reservation.id}`,
      title: `Overbooking risk on ${reservation.reservationNumber || reservation.id}`,
      detail: `This reservation is still unassigned inside the visible range and currently does not fit planner rules.`,
      severity: 'HIGH',
      targetType: 'reservation',
      targetId: reservation.id,
      href: buildReservationHref(reservation.id)
    }));
}

function topUnassigned(snapshot = {}) {
  return (snapshot?.unassignedReservations || [])
    .filter((reservation) => !reservation.overbooked)
    .slice(0, 5)
    .map((reservation) => ({
      id: `unassigned-${reservation.id}`,
      title: `Place unassigned reservation ${reservation.reservationNumber || reservation.id}`,
      detail: `This booking is still waiting for a vehicle assignment in the visible range.`,
      severity: 'MEDIUM',
      targetType: 'reservation',
      targetId: reservation.id,
      href: buildReservationHref(reservation.id)
    }));
}

function buildHeuristicCopilot(snapshot = {}, question = '') {
  const counters = snapshot?.counters || {};
  const shortage = snapshot?.shortage || {};
  const alerts = [
    ...topOverbooked(snapshot),
    ...topDamageTriage(snapshot),
    ...topInspectionAttention(snapshot),
    ...topTelematicsAttention(snapshot)
  ]
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, 8);

  const recommendations = [];
  if (Number(counters.overbooked || 0) > 0 || Number(shortage.totalCarsNeeded || 0) > 0) {
    recommendations.push({
      id: 'run-auto-accommodate',
      title: 'Run Auto-Accommodate and review shortage first',
      detail: shortage.totalCarsNeeded > 0
        ? `${shortage.totalCarsNeeded} extra unit(s) are still needed at peak visible demand, so dispatch should triage overbookings before lower-priority cleanup.`
        : 'Planner still has overbooked reservations that need a recommendation pass first.',
      actionLabel: 'Run Auto-Accommodate',
      actionType: 'AUTO_ACCOMMODATE',
      targetType: 'planner',
      targetId: null,
      href: null
    });
  }
  if (Number(counters.inspectionAttention || 0) > 0) {
    recommendations.push({
      id: 'inspection-review',
      title: 'Review inspection-readiness before assigning borderline units',
      detail: `${Number(counters.inspectionAttention || 0)} vehicle(s) have missing photo coverage, condition flags, or damage notes that should be reviewed before dispatch.`,
      actionLabel: 'Open Vehicle Queue',
      actionType: 'REVIEW_INSPECTIONS',
      targetType: 'vehicle',
      targetId: alerts.find((item) => item.targetType === 'vehicle')?.targetId || null,
      href: alerts.find((item) => item.targetType === 'vehicle')?.href || null
    });
  }
  if (Number(counters.damageReviewAttention || 0) > 0) {
    recommendations.push({
      id: 'damage-triage-review',
      title: 'Review damage triage before sending borderline units back out',
      detail: `${Number(counters.damageReviewAttention || 0)} vehicle(s) in the visible range have medium or high damage triage severity from the latest inspection.`,
      actionLabel: 'Open Vehicle Profile',
      actionType: 'REVIEW_DAMAGE_TRIAGE',
      targetType: 'vehicle',
      targetId: alerts.find((item) => item.id.startsWith('damage-triage-'))?.targetId || null,
      href: alerts.find((item) => item.id.startsWith('damage-triage-'))?.href || null
    });
  }
  if (Number(counters.telematicsAttention || 0) > 0) {
    recommendations.push({
      id: 'telematics-review',
      title: 'Check telematics, fuel, and GPS health before moving units across locations',
      detail: `${Number(counters.telematicsAttention || 0)} vehicle(s) do not have a healthy live signal in the current range, and some may also need fuel or GPS review.`,
      actionLabel: 'Open Vehicle Profile',
      actionType: 'REVIEW_TELEMATICS',
      targetType: 'vehicle',
      targetId: alerts.find((item) => item.id.startsWith('telematics-'))?.targetId || null,
      href: alerts.find((item) => item.id.startsWith('telematics-'))?.href || null
    });
  }
  if (Number(counters.lowFuelAttention || 0) > 0) {
    recommendations.push({
      id: 'fuel-review',
      title: 'Refuel low-fuel units before they become same-day dispatch failures',
      detail: `${Number(counters.lowFuelAttention || 0)} vehicle(s) in the visible range are reporting low or critical fuel from telematics.`,
      actionLabel: 'Open Vehicle Profile',
      actionType: 'REVIEW_FUEL',
      targetType: 'vehicle',
      targetId: alerts.find((item) => item.id.startsWith('telematics-'))?.targetId || null,
      href: alerts.find((item) => item.id.startsWith('telematics-'))?.href || null
    });
  }
  if (Number(counters.serviceHolds || 0) > 0) {
    recommendations.push({
      id: 'plan-maintenance',
      title: 'Review maintenance hold pressure against upcoming pickups',
      detail: `${Number(counters.serviceHolds || 0)} vehicle(s) are already blocked for maintenance or out-of-service windows in this visible range.`,
      actionLabel: 'Plan Maintenance',
      actionType: 'PLAN_MAINTENANCE',
      targetType: 'planner',
      targetId: null,
      href: null
    });
  }
  if (Number(counters.unassigned || 0) > 0 && Number(counters.overbooked || 0) === 0) {
    recommendations.push(...topUnassigned(snapshot).map((item) => ({
      ...item,
      actionLabel: 'Open Reservation',
      actionType: 'OPEN_RESERVATION'
    })));
  }

  const summary = Number(counters.overbooked || 0) > 0
    ? `Visible planner range has ${Number(counters.overbooked || 0)} overbooked reservation(s), ${Number(counters.unassigned || 0)} unassigned booking(s), and peak shortage of ${Number(shortage.totalCarsNeeded || 0)} vehicle(s).`
    : Number(counters.inspectionAttention || 0) > 0 || Number(counters.telematicsAttention || 0) > 0
      ? `Capacity is mostly stable, but operational readiness still needs attention on ${Number(counters.inspectionAttention || 0)} inspection-risk unit(s) and ${Number(counters.telematicsAttention || 0)} telematics-risk unit(s).`
      : Number(counters.lowFuelAttention || 0) > 0 || Number(counters.gpsAttention || 0) > 0
        ? `Capacity is mostly stable, but live telematics shows ${Number(counters.lowFuelAttention || 0)} low-fuel unit(s) and ${Number(counters.gpsAttention || 0)} unit(s) missing GPS coordinates.`
      : `Visible planner range looks stable. No overbookings are present, and the next best work is cleanup on unassigned bookings, wash, and maintenance timing.`;

  const followUps = [
    'Which reservations should I prioritize first in this visible range?',
    'Should I focus on shortage, maintenance, or wash planning next?',
    'Which vehicles are risky to assign because of inspection or telematics signals?'
  ];

  return {
    mode: 'HEURISTIC',
    aiEnabled: false,
    question: question || 'What should ops focus on next?',
    summary,
    riskLevel: inferRiskLevel(snapshot),
    alerts,
    recommendations: recommendations.slice(0, 8),
    followUps
  };
}

function buildAiContext(snapshot = {}) {
  return {
    range: snapshot?.range || {},
    filters: snapshot?.filters || {},
    counters: snapshot?.counters || {},
    shortage: snapshot?.shortage || {},
    recommendationSummary: snapshot?.recommendationSummary || {},
    overbookedReservations: (snapshot?.overbookedReservations || []).slice(0, 8).map((row) => ({
      id: row.id,
      reservationNumber: row.reservationNumber,
      pickupAt: row.pickupAt,
      returnAt: row.returnAt,
      customerName: [row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' '),
      vehicleType: row?.vehicleType?.name || row?.vehicleType?.code || 'Unspecified'
    })),
    unassignedReservations: (snapshot?.unassignedReservations || []).slice(0, 8).map((row) => ({
      id: row.id,
      reservationNumber: row.reservationNumber,
      pickupAt: row.pickupAt,
      returnAt: row.returnAt,
      customerName: [row?.customer?.firstName, row?.customer?.lastName].filter(Boolean).join(' '),
      vehicleType: row?.vehicleType?.name || row?.vehicleType?.code || 'Unspecified',
      overbooked: !!row.overbooked
    })),
    vehicleSignals: (snapshot?.vehicles || [])
      .filter((vehicle) => vehicle?.operationalSignals?.needsAttention)
      .slice(0, 10)
      .map((vehicle) => ({
        id: vehicle.id,
        internalNumber: vehicle.internalNumber,
        status: vehicle.status,
        inspectionStatus: vehicle?.operationalSignals?.inspection?.status || null,
        inspectionSummary: vehicle?.operationalSignals?.inspection?.summary || null,
        damageSeverity: vehicle?.operationalSignals?.inspection?.damageTriage?.severity || null,
        damageRecommendedAction: vehicle?.operationalSignals?.inspection?.damageTriage?.recommendedAction || null,
        telematicsStatus: vehicle?.operationalSignals?.telematics?.status || null,
        telematicsFuelStatus: vehicle?.operationalSignals?.telematics?.fuelStatus || null,
        telematicsGpsStatus: vehicle?.operationalSignals?.telematics?.gpsStatus || null,
        telematicsSummary: vehicle?.operationalSignals?.telematics?.summary || null
      }))
  };
}

async function recordCopilotUsage(scope = {}, payload = {}) {
  try {
    await settingsService.recordPlannerCopilotUsage(payload, scope);
  } catch {}
}

async function askOpenAiPlanner(snapshot = {}, question = '', config = {}) {
  const apiKey = String(config?.apiKey || '').trim()
    || (
      config?.allowGlobalApiKeyFallback
        ? String(process.env.OPENAI_API_KEY || '').trim()
        : ''
    );
  if (!apiKey) return null;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
      alerts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            detail: { type: 'string' },
            severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
            targetType: { type: ['string', 'null'], enum: ['planner', 'reservation', 'vehicle', null] },
            targetId: { type: ['string', 'null'] }
          },
          required: ['title', 'detail', 'severity', 'targetType', 'targetId']
        }
      },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            detail: { type: 'string' },
            actionLabel: { type: 'string' },
            actionType: { type: 'string', enum: ['OPEN_RESERVATION', 'REVIEW_UNIT', 'AUTO_ACCOMMODATE', 'PLAN_MAINTENANCE', 'PLAN_WASH', 'REVIEW_TELEMATICS', 'REVIEW_INSPECTIONS'] },
            targetType: { type: ['string', 'null'], enum: ['planner', 'reservation', 'vehicle', null] },
            targetId: { type: ['string', 'null'] }
          },
          required: ['title', 'detail', 'actionLabel', 'actionType', 'targetType', 'targetId']
        }
      },
      followUps: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['summary', 'riskLevel', 'alerts', 'recommendations', 'followUps']
  };

  const context = buildAiContext(snapshot);
  const model = String(config?.model || process.env.OPENAI_PLANNER_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'planner_copilot_response',
          strict: true,
          schema
        }
      },
      messages: [
        {
          role: 'system',
          content: 'You are an operations copilot for a rental fleet planner. Be concise, practical, and prioritize the next actions for dispatch staff. Never invent data not present in the context. Focus on overbooking, unassigned reservations, inspection readiness, telematics health, maintenance pressure, and wash timing.'
        },
        {
          role: 'user',
          content: `Planner context:\n${escapeJson(context)}\n\nOperator question: ${String(question || 'What should ops focus on next in this visible planner range?')}`
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Planner copilot AI request failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Planner copilot AI did not return content');
  const parsed = JSON.parse(content);
  return {
    mode: 'AI',
    aiEnabled: true,
    question: question || 'What should ops focus on next?',
    summary: parsed.summary,
    riskLevel: parsed.riskLevel,
    alerts: (parsed.alerts || []).map((item, index) => ({
      id: `ai-alert-${index}`,
      ...item,
      href: item.targetType === 'reservation' ? buildReservationHref(item.targetId) : item.targetType === 'vehicle' ? buildVehicleHref(item.targetId) : null
    })),
    recommendations: (parsed.recommendations || []).map((item, index) => ({
      id: `ai-rec-${index}`,
      ...item,
      href: item.targetType === 'reservation' ? buildReservationHref(item.targetId) : item.targetType === 'vehicle' ? buildVehicleHref(item.targetId) : null
    })),
    followUps: parsed.followUps || []
  };
}

export const plannerCopilotService = {
  async getClientConfig(scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required for planner copilot');
    const [config, usage] = await Promise.all([
      settingsService.getPlannerCopilotConfig(scope),
      settingsService.getPlannerCopilotUsage(scope)
    ]);
    const cap = Number(config?.monthlyQueryCap || 0);
    const currentQueries = Number(usage?.currentPeriod?.totalQueries || 0);
    const remaining = cap > 0 ? Math.max(0, cap - currentQueries) : null;
    return {
      ...config,
      usage: {
        currentPeriod: usage?.currentPeriod || { period: null, totalQueries: 0, aiResponses: 0, heuristicResponses: 0, modelCounts: {} },
        remainingQueries: remaining,
        monthlyCapReached: cap > 0 ? currentQueries >= cap : false
      }
    };
  },

  async advise(input = {}, scope = {}) {
    if (!scope?.tenantId) throw new Error('tenantId is required for planner copilot');
    const [config, usage] = await Promise.all([
      settingsService.getPlannerCopilotConfig(scope, { includeSecret: true }),
      settingsService.getPlannerCopilotUsage(scope)
    ]);
    if (!config?.planDefaults?.plannerCopilotIncluded) {
      throw new Error(`Planner Copilot is not included in the ${config?.tenantPlan || 'current'} plan`);
    }
    if (!config?.enabled) throw new Error('Planner Copilot is not enabled for this tenant');
    const currentPeriodQueries = Number(usage?.currentPeriod?.totalQueries || 0);
    const monthlyQueryCap = Number(config?.monthlyQueryCap || 0);
    if (monthlyQueryCap > 0 && currentPeriodQueries >= monthlyQueryCap) {
      throw new Error(`Planner Copilot monthly query cap reached for ${usage?.currentPeriod?.period || 'current period'} (${currentPeriodQueries}/${monthlyQueryCap})`);
    }
    const snapshot = await plannerService.getSnapshot({
      start: input?.start,
      end: input?.end,
      locationId: input?.locationId,
      vehicleTypeId: input?.vehicleTypeId
    }, scope);
    const question = String(input?.question || '').trim();
    const aiBlockedByPlan = !!config?.enabled && !config?.planEligible;
    const aiBlockedByModel = !!config?.enabled && !config?.modelAllowed;

    if (aiBlockedByPlan) {
      const response = {
        ...buildHeuristicCopilot(snapshot, question),
        featureEnabled: true,
        config: {
          enabled: !!config.enabled,
          model: config.model,
          credentialSource: config.credentialSource,
          ready: false,
          monthlyQueryCap: config.monthlyQueryCap,
          aiOnlyForPaidPlan: config.aiOnlyForPaidPlan,
          allowedPlans: config.allowedPlans,
          tenantPlan: config.tenantPlan,
          planEligible: config.planEligible
        },
        aiError: `AI responses are limited to paid plans. Tenant plan ${config?.tenantPlan || 'BETA'} is not eligible under the current copilot policy.`
      };
      await recordCopilotUsage(scope, {
        actorUserId: scope?.actorUserId || null,
        actorName: scope?.actorName || '',
        actorEmail: scope?.actorEmail || '',
        question,
        mode: response.mode,
        model: response?.config?.model || config.model,
        riskLevel: response.riskLevel,
        aiError: response.aiError
      });
      return response;
    }

    if (aiBlockedByModel) {
      const response = {
        ...buildHeuristicCopilot(snapshot, question),
        featureEnabled: true,
        config: {
          enabled: !!config.enabled,
          model: config.model,
          credentialSource: config.credentialSource,
          ready: false,
          monthlyQueryCap: config.monthlyQueryCap,
          aiOnlyForPaidPlan: config.aiOnlyForPaidPlan,
          allowedPlans: config.allowedPlans,
          tenantPlan: config.tenantPlan,
          planEligible: config.planEligible,
          allowedModels: config.allowedModels,
          modelAllowed: config.modelAllowed,
          planDefaults: config.planDefaults
        },
        aiError: `Configured model ${config?.model || 'n/a'} is not allowed for plan ${config?.tenantPlan || 'current'}. Allowed models: ${(config?.allowedModels || []).join(', ') || 'none configured'}.`
      };
      await recordCopilotUsage(scope, {
        actorUserId: scope?.actorUserId || null,
        actorName: scope?.actorName || '',
        actorEmail: scope?.actorEmail || '',
        question,
        mode: response.mode,
        model: response?.config?.model || config.model,
        riskLevel: response.riskLevel,
        aiError: response.aiError
      });
      return response;
    }

    try {
      const aiResult = await askOpenAiPlanner(snapshot, question, config);
      if (aiResult) {
        const response = {
          ...aiResult,
          featureEnabled: true,
          config: {
            enabled: !!config.enabled,
            model: config.model,
            credentialSource: config.credentialSource,
            ready: config.ready,
            monthlyQueryCap: config.monthlyQueryCap,
            aiOnlyForPaidPlan: config.aiOnlyForPaidPlan,
            allowedPlans: config.allowedPlans,
            allowedModels: config.allowedModels,
            tenantPlan: config.tenantPlan,
            planEligible: config.planEligible,
            modelAllowed: config.modelAllowed,
            planDefaults: config.planDefaults
          }
        };
        await recordCopilotUsage(scope, {
          actorUserId: scope?.actorUserId || null,
          actorName: scope?.actorName || '',
          actorEmail: scope?.actorEmail || '',
          question,
          mode: response.mode,
          model: response?.config?.model || config.model,
          riskLevel: response.riskLevel
        });
        return response;
      }
    } catch (error) {
      const response = {
        ...buildHeuristicCopilot(snapshot, question),
        featureEnabled: true,
        config: {
          enabled: !!config.enabled,
          model: config.model,
          credentialSource: config.credentialSource,
          ready: config.ready,
          monthlyQueryCap: config.monthlyQueryCap,
          aiOnlyForPaidPlan: config.aiOnlyForPaidPlan,
          allowedPlans: config.allowedPlans,
          allowedModels: config.allowedModels,
          tenantPlan: config.tenantPlan,
          planEligible: config.planEligible,
          modelAllowed: config.modelAllowed,
          planDefaults: config.planDefaults
        },
        aiError: error.message
      };
      await recordCopilotUsage(scope, {
        actorUserId: scope?.actorUserId || null,
        actorName: scope?.actorName || '',
        actorEmail: scope?.actorEmail || '',
        question,
        mode: response.mode,
        model: response?.config?.model || config.model,
        riskLevel: response.riskLevel,
        aiError: response.aiError
      });
      return response;
    }

    const response = {
      ...buildHeuristicCopilot(snapshot, question),
      featureEnabled: true,
      config: {
        enabled: !!config.enabled,
        model: config.model,
        credentialSource: config.credentialSource,
        ready: config.ready,
        monthlyQueryCap: config.monthlyQueryCap,
        aiOnlyForPaidPlan: config.aiOnlyForPaidPlan,
        allowedPlans: config.allowedPlans,
        allowedModels: config.allowedModels,
        tenantPlan: config.tenantPlan,
        planEligible: config.planEligible,
        modelAllowed: config.modelAllowed,
        planDefaults: config.planDefaults
      },
      aiError: config?.ready ? undefined : 'Planner Copilot AI is enabled for this tenant, but no API key is configured yet.'
    };
    await recordCopilotUsage(scope, {
      actorUserId: scope?.actorUserId || null,
      actorName: scope?.actorName || '',
      actorEmail: scope?.actorEmail || '',
      question,
      mode: response.mode,
      model: response?.config?.model || config.model,
      riskLevel: response.riskLevel,
      aiError: response.aiError
    });
    return response;
  }
};
