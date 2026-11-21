// Opiniones de los usuarios sobre la web ("Lo que dicen los makers").
// Se piden en un modal tras unas descargas, el admin las aprueba y solo las
// aprobadas con 4-5 estrellas, texto y consentimiento salen en la portada.

// Descargas a partir de las cuales se le pide la opinión al usuario
export const REVIEW_MIN_DOWNLOADS = 3;
// Estrellas mínimas para que una opinión aprobada pueda salir en la portada
export const REVIEW_PUBLIC_MIN_RATING = 4;

export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Valida y normaliza lo que envía el modal. Devuelve { data } o { error }.
export function parseReviewInput(body = {}) {
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'INVALID_RATING' };

  const displayName = cleanText(body.displayName, 60);
  if (displayName.length < 2) return { error: 'INVALID_NAME' };

  const text = cleanText(body.text, 500);
  const language = body.language === 'en' ? 'en' : 'es';

  return {
    data: {
      rating,
      displayName,
      text: text || null,
      consent: body.consent === true,
      language,
    },
  };
}

// Cambios que el admin puede hacer sobre una opinión. Devuelve { data } o { error }.
export function parseAdminReviewUpdate(body = {}) {
  const data = {};
  if (body.status !== undefined) {
    if (!REVIEW_STATUSES.includes(body.status)) return { error: 'INVALID_STATUS' };
    data.status = body.status;
    data.reviewedAt = body.status === 'PENDING' ? null : new Date();
  }
  if (body.featured !== undefined) data.featured = body.featured === true;
  if (body.text !== undefined) data.text = cleanText(body.text, 500) || null;
  if (body.displayName !== undefined) {
    const displayName = cleanText(body.displayName, 60);
    if (displayName.length < 2) return { error: 'INVALID_NAME' };
    data.displayName = displayName;
  }
  if (!Object.keys(data).length) return { error: 'NOTHING_TO_UPDATE' };
  return { data };
}

// ¿Hay que mostrarle el modal? Solo si ya descargó lo suficiente y aún no opinó.
export function shouldPromptReview({ downloads, hasReview }) {
  return !hasReview && Number(downloads) >= REVIEW_MIN_DOWNLOADS;
}

// Filtro de las opiniones que pueden salir en la portada
export const publicReviewWhere = {
  status: 'APPROVED',
  consent: true,
  rating: { gte: REVIEW_PUBLIC_MIN_RATING },
  text: { not: null },
};
