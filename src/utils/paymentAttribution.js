import {
  extractTrackingFromBody,
  pickTrackingForDb,
  resolveMarketingCampaignId,
  resolveTrackingForRequest,
} from './attribution.js';

export const PAYMENT_USER_TRACKING_SELECT = {
  id: true,
  email: true,
  language: true,
  marketingCampaignId: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  utmContent: true,
  utmTerm: true,
  clickGclid: true,
  clickFbclid: true,
  clickTtclid: true,
  clickMsclkid: true,
  utmLandingUrl: true,
  utmReferrer: true,
};

const toUserTracking = (user) => {
  if (!user) return null;
  return extractTrackingFromBody({
    utmSource: user.utmSource,
    utmMedium: user.utmMedium,
    utmCampaign: user.utmCampaign,
    utmContent: user.utmContent,
    utmTerm: user.utmTerm,
    clickGclid: user.clickGclid,
    clickFbclid: user.clickFbclid,
    clickTtclid: user.clickTtclid,
    clickMsclkid: user.clickMsclkid,
    landingUrl: user.utmLandingUrl,
    referrer: user.utmReferrer,
    marketingCampaignId: user.marketingCampaignId,
  });
};

const pickFirst = (...values) => values.find((value) => value != null) || null;

const mergeTracking = ({ requestTracking, gatewayTracking, userTracking }) => {
  return {
    utmSource: pickFirst(requestTracking?.utmSource, gatewayTracking?.utmSource, userTracking?.utmSource),
    utmMedium: pickFirst(requestTracking?.utmMedium, gatewayTracking?.utmMedium, userTracking?.utmMedium),
    utmCampaign: pickFirst(requestTracking?.utmCampaign, gatewayTracking?.utmCampaign, userTracking?.utmCampaign),
    utmContent: pickFirst(requestTracking?.utmContent, gatewayTracking?.utmContent, userTracking?.utmContent),
    utmTerm: pickFirst(requestTracking?.utmTerm, gatewayTracking?.utmTerm, userTracking?.utmTerm),
    clickGclid: pickFirst(requestTracking?.clickGclid, gatewayTracking?.clickGclid, userTracking?.clickGclid),
    clickFbclid: pickFirst(requestTracking?.clickFbclid, gatewayTracking?.clickFbclid, userTracking?.clickFbclid),
    clickTtclid: pickFirst(requestTracking?.clickTtclid, gatewayTracking?.clickTtclid, userTracking?.clickTtclid),
    clickMsclkid: pickFirst(requestTracking?.clickMsclkid, gatewayTracking?.clickMsclkid, userTracking?.clickMsclkid),
    landingUrl: pickFirst(requestTracking?.landingUrl, gatewayTracking?.landingUrl, userTracking?.landingUrl),
    referrer: pickFirst(requestTracking?.referrer, gatewayTracking?.referrer, userTracking?.referrer),
    marketingCampaignId: pickFirst(
      requestTracking?.marketingCampaignId,
      gatewayTracking?.marketingCampaignId,
      userTracking?.marketingCampaignId
    ),
  };
};

const resolveCampaignIdWithFallbacks = async (prismaLike, candidates = []) => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = await resolveMarketingCampaignId(prismaLike, candidate);
    if (resolved) return resolved;
  }
  return null;
};

export const resolvePaymentAttribution = async ({ prismaLike, req, user, gatewayTracking = null }) => {
  const trackingResolved = await resolveTrackingForRequest(prismaLike, req, 'last');
  const requestTracking = trackingResolved?.tracking || null;
  const userTracking = toUserTracking(user);

  const mergedTracking = mergeTracking({
    requestTracking,
    gatewayTracking,
    userTracking,
  });

  const resolvedCampaignId = await resolveCampaignIdWithFallbacks(prismaLike, [
    requestTracking,
    gatewayTracking,
    mergedTracking,
    userTracking,
  ]);

  return {
    requestTracking,
    mergedTracking,
    marketingCampaignId:
      resolvedCampaignId ||
      trackingResolved?.marketingCampaignId ||
      user?.marketingCampaignId ||
      mergedTracking?.marketingCampaignId ||
      null,
    trackingForDb: pickTrackingForDb(mergedTracking),
  };
};

export const extractGatewayTrackingFromMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object') return null;
  return extractTrackingFromBody(metadata);
};
