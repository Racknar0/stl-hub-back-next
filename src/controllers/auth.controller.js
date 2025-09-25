import { PrismaClient } from '@prisma/client';
import { transporter } from './nodeMailerController.js';
import { comparePassword, hashPassword } from '../utils/bcryptUtils.js';
import { generateRandomToken } from '../utils/cryptoUtils.js';
import { generateJWT } from '../utils/jwtUtils.js';

const prisma = new PrismaClient();

// Tipos de suscripciones
const subscriptionTypes = {
    THREE_MONTHS: 'three_months',
    SIX_MONTHS: 'six_months',
    ONE_YEAR: 'one_year',
};

// login a user
// login a user
export const login = async (req, res) => {
  const { email, password, language = 'en' } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      message: language === 'en' ? 'Please provide email and password' : 'Por favor ingresa email y contraseña',
    });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(400).json({
        message: language === 'en' ? 'Invalid credentials' : 'Credenciales inválidas',
      });
    }

    const passwordMatch = await comparePassword(password, user.password);
    if (!passwordMatch) {
      return res.status(400).json({
        message: language === 'en' ? 'Invalid credentials' : 'Credenciales inválidas',
      });
    }

    if (!user.isActive) {
      return res.status(400).json({
        message: language === 'en' ? 'Account is inactive' : 'La cuenta está inactiva',
      });
    }

    // 👉 AUDITORÍA DE SUSCRIPCIÓN EN LOGIN
    const now = new Date();

    // Tomamos la suscripción más reciente por currentPeriodEnd
    const lastSub = await prisma.subscription.findFirst({
      where: { userId: user.id },
      orderBy: { currentPeriodEnd: 'desc' },
    });

    let subscriptionPayload = null;

    if (lastSub) {
      let newStatus = lastSub.status;

      // Si estaba ACTIVE y ya venció, marcar EXPIRED
      if (lastSub.status === 'ACTIVE' && lastSub.currentPeriodEnd < now) {
        newStatus = 'EXPIRED';
        await prisma.subscription.update({
          where: { id: lastSub.id },
          data: { status: 'EXPIRED' },
        });
      }

      // Opcional: calcula días restantes (0 si vencida o sin días)
      const ms = lastSub.currentPeriodEnd.getTime() - now.getTime();
      const daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));

      subscriptionPayload = {
        status: newStatus,
        currentPeriodEnd: lastSub.currentPeriodEnd,
        daysRemaining,
      };

      // (Opcional, limpieza): marca TODAS las subs con end < now como EXPIRED
      await prisma.subscription.updateMany({
        where: { userId: user.id, currentPeriodEnd: { lt: now }, NOT: { status: 'EXPIRED' } },
        data: { status: 'EXPIRED' },
      });
    }

    // Crear token JWT (incluye roleId)
    const token = generateJWT({ id: user.id, roleId: user.roleId });

    // Respuesta:
    // - Mantengo message/token como antes para no romper frontend.
    // - Agrego "subscription" si quieres usarlo en /login directo (opcional).
    return res.status(200).json({
      message: language === 'en' ? 'Login successful' : 'Inicio de sesión exitoso',
      token,
      // 🔽 opcional, elimina si no lo vas a usar desde el front en /login
      subscription: subscriptionPayload,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: language === 'en' ? 'Internal server error' : 'Error interno del servidor',
    });
  }
};


// forgot password
export const forgotPassword = async (req, res) => {
    const { email, language = 'en' } = req.body;

    // Validar que se proporcione un email
    if (!email) {
        return res
            .status(400)
            .json({
                message: `${
                    language === 'en'
                        ? 'Email is required'
                        : 'El correo electrónico es obligatorio'
                }`,
            });
    }

    try {
        // Buscar el usuario por email
        const user = await prisma.user.findUnique({
            where: { email },
        });

        if (!user) {
            // Por seguridad, mensaje genérico
            return res
                .status(200)
                .json({
                    message: `${
                        language === 'en'
                            ? 'If an account is associated with this email, you will receive instructions to reset your password.'
                            : 'Si existe una cuenta asociada a este correo, recibirás instrucciones para restablecer tu contraseña.'
                    }`,
                });
        }

        // Generar un token para resetear la contraseña
        const resetToken = generateRandomToken();
        // Establecer la expiración del token, por ejemplo, 1 hora
        const resetTokenExpiration = new Date(Date.now() + 60 * 60 * 1000);

        // Actualizar el usuario con el token y su expiración
        await prisma.user.update({
            where: { id: user.id },
            data: {
                resetToken,
                resetTokenExpiration,
            },
        });

        // Construir el enlace de reseteo
        const resetLink = `${process.env.FRONT_URL}/login?reset=${resetToken}`;

        // Enviar el email de reseteo de contraseña
        await transporter.sendMail({
            to: email,
            from: process.env.SMTP_EMAIL,
            subject:
                language === 'en'
                    ? 'Password Reset Request'
                    : 'Solicitud de restablecimiento de contraseña',
            html: `<p>${ language === 'en' ? 'You have requested a password reset.' : 'Has solicitado un restablecimiento de contraseña.' }</p> <p>${ language === 'en' ? 'Please click the link below to reset your password:' : 'Por favor, haz clic en el siguiente enlace para restablecer tu contraseña:' }</p> <p><a href="${resetLink}">${resetLink}</a></p> <p>${ language === 'en' ? 'This link will expire in 1 hour.' : 'Este enlace expirará en 1 hora.' }</p>`,
        });

        return res
            .status(200)
            .json({ message: `${ language === 'en' ? 'Password reset email sent' : 'Correo de restablecimiento de contraseña enviado' }`, });
    } catch (error) {
        console.error('Error in forgotPassword:', error);
        return res
            .status(500)
            .json({
                message: `${
                    language === 'en'
                        ? 'Internal server error'
                        : 'Error interno del servidor'
                }`,
            });
    }
};

// reset password
export const resetPassword = async (req, res) => {
    try {
        const { token, language = 'en', password } = req.body;

        // Validar que se proporcione una nueva contraseña
        if (!password) {
            return res.status(400).json({ message: 'Password is required' });
        }

        // Buscar el usuario que tenga el token de reseteo y cuyo token aún no haya expirado
        const user = await prisma.user.findFirst({
            where: {
                resetToken: token,
                resetTokenExpiration: {
                    gte: new Date(),
                },
            },
        });

        if (!user) {
            return res
                .status(401)
                .json({ message: 'Invalid or expired token' });
        }

        // Encriptar la nueva contraseña
        const hashedPassword = await hashPassword(password);

        // Actualizar la contraseña del usuario y limpiar el token y su expiración.
        const updatedUser = await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                resetToken: null,
                resetTokenExpiration: null,
                lastPasswordChange: new Date(),
            },
        });

        return res
            .status(200)
            .json({
                message: 'Password reset successfully',
                user: { id: updatedUser.id, email: updatedUser.email },
            });
    } catch (error) {
        console.error('Error in resetPassword:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Revisión y corrección: registro por venta con suscripción
export const registerUserSale = async (req, res) => {
    try {
        const { email, password, type_subscription, daysToAdd } = req.body;

        if (!email || !password) {
            return res
                .status(400)
                .json({ message: 'Please provide email and password' });
        }

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists' });
        }

        const hashedPassword = await hashPassword(password);

        // Helpers para fechas sin mutar el objeto original
        const now = new Date();
        const addMonths = (date, months) => {
            const d = new Date(date);
            d.setMonth(d.getMonth() + months);
            return d;
        };
        const addYears = (date, years) => {
            const d = new Date(date);
            d.setFullYear(d.getFullYear() + years);
            return d;
        };
        const addDays = (date, days) => {
            const d = new Date(date);
            d.setDate(d.getDate() + days);
            return d;
        };

        let expirationDate;
        // Preferir daysToAdd si viene válido; si no, usar type_subscription (compatibilidad)
        const days = Number(daysToAdd);
        if (Number.isFinite(days) && days > 0) {
            // Limitar razonable (máx ~10 años)
            const safeDays = Math.min(days, 3650);
            expirationDate = addDays(now, safeDays);
        } else {
            if (!type_subscription) {
                return res
                    .status(400)
                    .json({
                        message:
                            'Please provide daysToAdd or a valid subscription type',
                    });
            }
            if (!Object.values(subscriptionTypes).includes(type_subscription)) {
                return res
                    .status(400)
                    .json({ message: 'Invalid subscription type' });
            }
            switch (type_subscription) {
                case subscriptionTypes.THREE_MONTHS:
                    expirationDate = addMonths(now, 3);
                    break;
                case subscriptionTypes.SIX_MONTHS:
                    expirationDate = addMonths(now, 6);
                    break;
                case subscriptionTypes.ONE_YEAR:
                    expirationDate = addYears(now, 1);
                    break;
                default:
                    return res
                        .status(400)
                        .json({ message: 'Invalid subscription type' });
            }
        }

        // Transacción: crear usuario (activo) y su suscripción
        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
                data: {
                    email,
                    password: hashedPassword,
                    roleId: 1, // rol por defecto: user
                    isActive: true, // activar cuenta al comprar
                },
            });

            const subscription = await tx.subscription.create({
                data: {
                    userId: user.id,
                    status: 'ACTIVE',
                    startedAt: now,
                    currentPeriodEnd: expirationDate,
                },
            });

            return { user, subscription };
        });

        return res.status(201).json({
            message: 'User registered successfully',
            user: { id: result.user.id, email: result.user.email },
            subscription: result.subscription,
        });
    } catch (error) {
        console.error('Error in registerUserSale:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Registro de usuario con activationToken
export const register = async (req, res) => {
    const { email, password, language = 'es' } = req.body;

    if (!email || !password) {
        return res
            .status(400)
            .json({ message: 'Email and password are required' });
    }

    try {
        // Verifica si el usuario ya existe
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(409).json({ message: 'User already exists' });
        }

        // Hashea la contraseña
        const hashedPassword = await hashPassword(password);

        // Genera un token de activación seguro
        const activationToken = generateRandomToken();

        // Crea el usuario
        const user = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                language,
                isActive: false,
                activationToken,
                roleId: 1, // rol por defecto: user
            },
        });

        // crear logica de envio de email
        const activationLink = `${process.env.FRONT_URL}/register?activate=${activationToken}`;
        await transporter.sendMail({
            to: email,
            from: process.env.SMTP_EMAIL,
            subject:
                language === 'en'
                    ? 'Activate your account'
                    : 'Activa tu cuenta',
            html: `<p>${
                language === 'en'
                    ? 'Please click the link below to activate your account:'
                    : 'Por favor, haz clic en el siguiente enlace para activar tu cuenta:'
            }</p>
             <p><a href="${activationLink}">${activationLink}</a></p>`,
        });

        return res.status(201).json({
            message: `${
                language === 'en'
                    ? 'User registered. Please check your email to activate your account.'
                    : 'Usuario registrado. Por favor, revisa tu correo electrónico para activar tu cuenta.'
            }`,
            user: { id: user.id, email: user.email, language: user.language },
        });
    } catch (error) {
        console.error('Error in register:', error);
        return res
            .status(500)
            .json({
                message: `${
                    language === 'en'
                        ? 'Internal server error'
                        : 'Error interno del servidor'
                }`,
            });
    }
};

// Activar cuenta con activationToken
export const activateAccount = async (req, res) => {
    const { token, language } = req.body;
    console.log('Activation request - token:', token, 'language:', language);
    if (!token) {
        return res
            .status(401)
            .json({
                message: `${
                    language === 'en'
                        ? 'Activation token is required'
                        : 'Se requiere el token de activación'
                }`,
            });
    }
    try {
        // Buscar usuario con ese activationToken
        const user = await prisma.user.findFirst({
            where: { activationToken: token },
        });
        if (!user) {
            return res
                .status(401)
                .json({
                    message: `${
                        language === 'en'
                            ? 'Invalid or expired activation token'
                            : 'Token de activación inválido o expirado'
                    }`,
                });
        }
        // Activar cuenta y limpiar el token
        await prisma.user.update({
            where: { id: user.id },
            data: { isActive: true, activationToken: null },
        });
        return res
            .status(200)
            .json({
                message: `${
                    language === 'en'
                        ? 'Account activated successfully'
                        : 'Cuenta activada con éxito'
                }`,
            });
    } catch (error) {
        console.error('Error in activateAccount:', error);
        return res
            .status(500)
            .json({
                message: `${
                    language === 'en'
                        ? 'Internal server error'
                        : 'Error interno del servidor'
                }`,
            });
    }
};
