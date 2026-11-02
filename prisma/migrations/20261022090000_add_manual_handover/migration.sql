BEGIN TRY

BEGIN TRAN;

-- AlterTable: "Tandai Terkirim" (schedule marked delivered by an admin)
ALTER TABLE [dbo].[DistributionSubmittance] ADD [isManual] BIT NOT NULL CONSTRAINT [DistributionSubmittance_isManual_df] DEFAULT 0,
[handoverAt] DATETIME2;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
