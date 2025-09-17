import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../utils/bcryptUtils.js';

const prisma = new PrismaClient();

// Create a new user (minimal: email, password, roleId)
export const createUser = async (req, res) => {
  const { email, password, roleId = 1, isActive = true } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    // Verificar que el email no esté registrado
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ message: 'Email already in use' });

    const passwordHashed = await hashPassword(password);

    const newUser = await prisma.user.create({
      data: {
        email,
        password: passwordHashed,
        roleId,
        isActive,
      },
      select: { id: true, email: true, isActive: true, createdAt: true, roleId: true },
    });

    return res.status(201).json(newUser);
  } catch (error) {
    console.error('Error creating user:', error);
    return res.status(500).json({ message: 'Error creating user' });
  }
};

// Get all users (omit password)
export const getUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, isActive: true, createdAt: true, updatedAt: true, roleId: true },
    });
    res.status(200).json(users);
  } catch (error) {
    console.log('Error getting users: ', error);
    res.status(500).json({ message: 'Error getting users' });
  }
};

// Get user by id (omit password)
export const getUserById = async (req, res) => {
  const { id } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(id) },
      select: { id: true, email: true, isActive: true, createdAt: true, updatedAt: true, roleId: true },
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json(user);
  } catch (error) {
    console.log('Error getting user: ', error);
    res.status(500).json({ message: 'Error getting user' });
  }
};

// Update user (email, password, isActive, roleId)
export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { email, password, isActive, roleId } = req.body;

  try {
    const dataToUpdate = { };
    if (email !== undefined) dataToUpdate.email = email;
    if (isActive !== undefined) dataToUpdate.isActive = isActive;
    if (roleId !== undefined) dataToUpdate.roleId = roleId;

    if (password) {
      dataToUpdate.password = await hashPassword(password);
    }

    const updatedUser = await prisma.user.update({
      where: { id: parseInt(id) },
      data: dataToUpdate,
      select: { id: true, email: true, isActive: true, createdAt: true, updatedAt: true, roleId: true },
    });

    return res.status(200).json(updatedUser);
  } catch (error) {
    console.error('Error updating user:', error);
    return res.status(500).json({ message: 'Error updating user' });
  }
};

// Delete user
export const deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    const deletedUser = await prisma.user.delete({
      where: { id: parseInt(id) },
      select: { id: true, email: true, isActive: true, roleId: true },
    });

    res.status(200).json(deletedUser);
  } catch (error) {
    console.log('Error deleting user: ', error);
    res.status(500).json({ message: 'Error deleting user' });
  }
};
