const plans = {
  '1m': {
    name_es: 'Suscripción 30 Días',
    name_en: '30 Day Subscription',
    price: '5.00', // Precio como string, recomendado por PayPal
    currency: 'USD',
    durationDays: 30,
  },
  '3m': {
    name_es: 'Suscripción 90 Días',
    name_en: '90 Day Subscription',
    price: '10.00',
    currency: 'USD',
    durationDays: 90,
  },
  '6m': {
    name_es: 'Suscripción 180 Días',
    name_en: '180 Day Subscription',
    price: '17.00',
    currency: 'USD',
    durationDays: 180,
  },
  '12m': {
    name_es: 'Suscripción 365 Días',
    name_en: '365 Day Subscription',
    price: '25.00',
    currency: 'USD',
    durationDays: 365,
  },
};

export default plans;