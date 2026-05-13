import type { NextFunction, Request, Response } from "express";
import prisma from "../../lib/prisma";

class CheckpointAccess {
  /**
   * Loads the checkpoint codes the authenticated user is allowed to access
   * (derived from their circle's CheckpointCircle assignments) and attaches
   * them to req.checkpointCodes. Must run after Auth.authenticate.
   */
  static async load(req: Request, res: Response, next: NextFunction) {
    try {
      const checkpointCircles = await prisma.checkpointCircle.findMany({
        where: { circleCode: req.user!.circleCode },
        select: { checkpointCode: true }
      });

      req.checkpointCodes = checkpointCircles.map(cc => cc.checkpointCode);
      next();
    } catch (error) {
      next(error);
    }
  }
}

export default CheckpointAccess;
