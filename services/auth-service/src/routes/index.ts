import { Router } from 'express';
import authRoutes from './authRoutes.js';
import businessRoutes from './businessRoutes.js';
import workspaceRoutes from './workspaceRoutes.js';
import memberRoutes from './memberRoutes.js';
import teamRoutes from './teamRoutes.js';
import roleRoutes from './roleRoutes.js';

const router = Router();

// Mount public routes at /
router.use('/', authRoutes);
router.use('/', businessRoutes);

// Mount workspace and settings sub-routes at /workspace to avoid route collisions
router.use('/workspace', workspaceRoutes);
router.use('/workspace', teamRoutes);
router.use('/workspace', roleRoutes);

// Mount member routes at / (memberRoutes contains both /workspace/members and /members)
router.use('/', memberRoutes);

export default router;
