import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("feature_flags", "0006_validate_archived_flag_must_be_disabled"),
        ("approvals", "0001_migrate_approvals_models"),
    ]

    operations = [
        migrations.AddField(
            model_name="scheduledchange",
            name="change_request",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="scheduled_changes",
                to="approvals.changerequest",
            ),
        ),
    ]
