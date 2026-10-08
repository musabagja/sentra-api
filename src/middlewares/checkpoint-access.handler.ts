import type { NextFunction, Request, Response } from "express";
import prisma from "../../lib/prisma";
import { ALL_CIRCLES_ACCESS } from "../utils/access.util";

class CheckpointAccess {
  /**
   * Loads the checkpoint codes the authenticated user is allowed to access
   * (derived from their circle's CheckpointCircle assignments) and attaches
   * them to req.checkpointCodes. A holder of ALL_CIRCLES_ACCESS gets every checkpoint and
   * req.allCircles, which makes every circle check pass. Must run after Auth.authenticate.
   */
  static async load(req: Request, res: Response, next: NextFunction) {
    try {
      const allCircles = !!(await prisma.permission.findFirst({
        where: { userCode: req.user!.code, accessCode: ALL_CIRCLES_ACCESS, status: true },
        select: { id: true }
      }));

      if (allCircles) {
        const checkpoints = await prisma.checkpoint.findMany({ select: { code: true } });
        req.allCircles = true;
        req.checkpointCodes = checkpoints.map(cp => cp.code);
      } else {
        const checkpointCircles = await prisma.checkpointCircle.findMany({
          where: { circleCode: req.user!.circleCode },
          select: { checkpointCode: true }
        });
        req.checkpointCodes = checkpointCircles.map(cc => cc.checkpointCode);
      }
      next();
    } catch (error) {
      next(error);
    }
  }
}

export default CheckpointAccess;
