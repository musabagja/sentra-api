import prisma from '../../lib/prisma';
import { buildPlaceWhere, buildSoldRange } from './list-filters.util';

/**
 * Every place of the caller's circle (narrowed by circle / type / search) with how many sales it
 * has in the date range, most sold first. Used by the Riwayat tab and its Excel export.
 */
export const rankSalesByPlace = async (query: any, circleCode: string) => {
  // The caller's circle always applies; the circle / type / search filters can only narrow it
  const placeWhere = buildPlaceWhere(query, circleCode);
  const createdAt = buildSoldRange(query);

  const [places, soldRows] = await Promise.all([
    prisma.checkpoint.findMany({ where: placeWhere, select: { code: true, name: true, type: true } }),
    prisma.merge.groupBy({
      by: ['checkpointCode'],
      _count: { _all: true },
      where: { ...(createdAt ? { createdAt } : {}), checkpoint: placeWhere }
    })
  ]);

  const soldByCode = new Map(soldRows.map(r => [r.checkpointCode, r._count._all]));
  return places
    .map(p => ({ code: p.code, name: p.name, type: p.type, sold: soldByCode.get(p.code) ?? 0 }))
    .sort((a, b) => b.sold - a.sold || a.name.localeCompare(b.name));
};
