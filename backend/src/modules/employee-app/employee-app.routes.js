import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { employeeAppService } from './employee-app.service.js';

export const employeeAppRouter = Router();

employeeAppRouter.use(requireRole('ADMIN', 'OPS', 'AGENT'));

employeeAppRouter.get('/dashboard', async (req, res, next) => {
  try {
    res.json(await employeeAppService.getDashboard(req.user, {
      query: req.query?.q ? String(req.query.q) : ''
    }));
  } catch (error) {
    next(error);
  }
});
