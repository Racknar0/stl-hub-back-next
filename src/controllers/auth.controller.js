import { PrismaClient } from "@prisma/client";
import { transporter } from "./nodeMailerController.js";
import { comparePassword, hashPassword } from "../utils/bcryptUtils.js";
import { generateRandomToken } from "../utils/cryptoUtils.js";
import { generateJWT } from "../utils/jwtUtils.js";

const prisma = new PrismaClient();


// Tipos de suscripciones
const subscriptionTypes = {
    THREE_MONTHS: 'three_months',
    SIX_MONTHS: 'six_months',
    ONE_YEAR: 'one_year',
};

// login a user
export const login = async (req, res) => {

    const { email, password } = req.body;

    // Validar que se proporcione un email y una contraseña
    if (!email || !password) {
        return res.status(400).json({ message: 'Please provide email and password' });
    }

    try {
        const user = await prisma.user.findUnique({ where: { email } });

        if (!user) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        // Comparar la contraseña proporcionada con la almacenada en la base de datos
        const passwordMatch = await comparePassword(password, user.password);

        if (!passwordMatch) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        // Verificar si el usuario está activo
        if (!user.isActive) {
            return res.status(400).json({ message: 'Account is inactive' });
        }

        // Crear un token de autenticación (incluye roleId para permitir UI condicional en frontend)
        const token = generateJWT({ id: user.id, roleId: user.roleId });

        // Retornar el token
        return res.status(200).json({ message: 'Login successful', token});

    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Internal server error' });
    }

};

// forgot password
export const forgotPassword = async (req, res) => {
    const { email } = req.body;
  
    // Validar que se proporcione un email
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }
  
    try {
      // Buscar el usuario por email
      const user = await prisma.user.findUnique({
        where: { email }
      });
  
      if (!user) {
        // Por seguridad, mensaje genérico
        return res.status(200).json({ message: 'Si existe una cuenta asociada a este correo, recibirás instrucciones para restablecer tu contraseña.' });
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
          resetTokenExpiration
        }
      });
  
      // Construir el enlace de reseteo
      const resetLink = `${process.env.API_URL}/auth/reset-password/${resetToken}`;
  
      // Enviar el email de reseteo de contraseña
      await transporter.sendMail({
        to: email,
        from: process.env.SMTP_EMAIL,
        subject: 'Password Reset Request',
        html: `<p>You have requested a password reset.</p>
               <p>Please click the link below to reset your password:</p>
               <p><a href="${resetLink}">Reset Password</a></p>
               <p>This link will expire in 1 hour.</p>`
      });
  
      return res.status(200).json({ message: 'Password reset email sent' });
    } catch (error) {
      console.error('Error in forgotPassword:', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  };

// reset password
export const resetPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password } = req.body;
    
        // Validar que se proporcione una nueva contraseña
        if (!password) {
        return res.status(400).json({ message: 'Password is required' });
        }
    
        // Buscar el usuario que tenga el token de reseteo y cuyo token aún no haya expirado
        const user = await prisma.user.findFirst({
        where: {
            resetToken: token,
            resetTokenExpiration: {
            gte: new Date()
            }
        }
        });
    
        if (!user) {
        return res.status(400).json({ message: 'Invalid or expired token' });
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
            lastPasswordChange: new Date()
        }
        });
    
        return res.status(200).json({ message: 'Password reset successfully', user: { id: updatedUser.id, email: updatedUser.email } });
    } catch (error) {
        console.error("Error in resetPassword:", error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Revisión y corrección: registro por venta con suscripción
export const registerUserSale = async (req, res) => {
  try {
    const { email, password, type_subscription } = req.body;

    if (!email || !password || !type_subscription) {
      return res.status(400).json({ message: 'Please provide email, password and subscription type' });
    }

    if (!Object.values(subscriptionTypes).includes(type_subscription)) {
      return res.status(400).json({ message: 'Invalid subscription type' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await hashPassword(password);

    // Helpers para fechas sin mutar el objeto original
    const now = new Date();
    const addMonths = (date, months) => { const d = new Date(date); d.setMonth(d.getMonth() + months); return d; };
    const addYears  = (date, years)  => { const d = new Date(date); d.setFullYear(d.getFullYear() + years); return d; };

    let expirationDate;
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
        return res.status(400).json({ message: 'Invalid subscription type' });
    }

    // Transacción: crear usuario (activo) y su suscripción
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          roleId: 1,          // rol por defecto: user
          isActive: true,     // activar cuenta al comprar
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
