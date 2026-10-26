BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Merge] ADD [anomalyAt] DATETIME2,
[anomalyByCode] NVARCHAR(1000),
[anomalyNote] NVARCHAR(1000);

-- AlterTable
ALTER TABLE [dbo].[MergeAdditional] ADD [anomalyAt] DATETIME2,
[anomalyByCode] NVARCHAR(1000),
[anomalyNote] NVARCHAR(1000);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
