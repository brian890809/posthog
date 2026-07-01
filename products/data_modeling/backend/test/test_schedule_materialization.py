from datetime import timedelta

from posthog.test.base import BaseTest
from unittest import mock

from products.data_modeling.backend.logic.freshness import UnsupportedFrequencyTargetError
from products.data_modeling.backend.logic.node_frequency import get_frequency_target
from products.data_modeling.backend.models import DAG, Node
from products.data_modeling.backend.models.datawarehouse_saved_query import DataWarehouseSavedQuery
from products.data_modeling.backend.models.node import NodeType

SERVICE = "products.data_warehouse.backend.logic.data_load.saved_query_service"
GET_V2_DAG_IDS = "products.data_modeling.backend.schedule.get_v2_scheduled_dag_ids"
RECONCILE = "products.data_modeling.backend.logic.schedule_reconcile"


class TestScheduleMaterializationV2Guard(BaseTest):
    def setUp(self):
        super().setUp()
        self.dag = DAG.objects.create(team=self.team, name="Default")
        self.sq = DataWarehouseSavedQuery.objects.create(
            name="view",
            team=self.team,
            query={"query": "SELECT 1", "kind": "HogQLQuery"},
            sync_frequency_interval=timedelta(hours=12),
        )
        Node.objects.create(team=self.team, dag=self.dag, saved_query=self.sq, type=NodeType.VIEW)

    def test_skips_v1_and_nulls_frequency_when_dag_on_v2(self):
        with (
            mock.patch(GET_V2_DAG_IDS, return_value={str(self.dag.id)}),
            mock.patch(f"{SERVICE}.sync_saved_query_workflow") as sync_wf,
            mock.patch(f"{SERVICE}.saved_query_workflow_exists", return_value=False),
            mock.patch.object(DataWarehouseSavedQuery, "setup_model_paths") as setup_paths,
        ):
            self.sq.schedule_materialization()
        sync_wf.assert_not_called()
        setup_paths.assert_not_called()
        self.sq.refresh_from_db()
        assert self.sq.sync_frequency_interval is None

    def test_creates_v1_schedule_when_dag_not_on_v2(self):
        with (
            mock.patch(GET_V2_DAG_IDS, return_value=set()),
            mock.patch(f"{SERVICE}.sync_saved_query_workflow") as sync_wf,
            mock.patch(f"{SERVICE}.saved_query_workflow_exists", return_value=False),
            mock.patch.object(DataWarehouseSavedQuery, "setup_model_paths"),
        ):
            self.sq.schedule_materialization()
        sync_wf.assert_called_once()
        self.sq.refresh_from_db()
        assert self.sq.sync_frequency_interval == timedelta(hours=12)

    def test_tiered_flag_writes_target_through_and_keeps_mirror(self):
        node = Node.objects.get(saved_query=self.sq)
        with (
            mock.patch(GET_V2_DAG_IDS, return_value={str(self.dag.id)}),
            mock.patch(f"{RECONCILE}.tiered_schedules_enabled", return_value=True),
            mock.patch(f"{RECONCILE}.maybe_reconcile_dag") as reconcile,
        ):
            self.sq.schedule_materialization()
        node.refresh_from_db()
        self.sq.refresh_from_db()
        assert get_frequency_target(node) == timedelta(hours=12)
        assert self.sq.sync_frequency_interval == timedelta(hours=12)
        reconcile.assert_called_once()

    def test_tiered_flag_surfaces_invalid_frequency_without_disabling(self):
        # an invalid frequency is a request problem: it must reach the caller as a validation
        # error, not silently flip is_materialized like infrastructure failures do
        self.sq.is_materialized = True
        self.sq.sync_frequency_interval = timedelta(minutes=45)
        self.sq.save(update_fields=["is_materialized", "sync_frequency_interval"])
        with (
            mock.patch(GET_V2_DAG_IDS, return_value={str(self.dag.id)}),
            mock.patch(f"{RECONCILE}.tiered_schedules_enabled", return_value=True),
        ):
            try:
                self.sq.schedule_materialization()
                raise AssertionError("expected UnsupportedFrequencyTargetError")
            except UnsupportedFrequencyTargetError:
                pass
        self.sq.refresh_from_db()
        assert self.sq.is_materialized is True

    def test_disables_materialization_when_v2_lookup_fails(self):
        self.sq.is_materialized = True
        self.sq.save(update_fields=["is_materialized"])
        with (
            mock.patch(GET_V2_DAG_IDS, side_effect=Exception("temporal unavailable")),
            mock.patch(f"{SERVICE}.sync_saved_query_workflow") as sync_wf,
            mock.patch(f"{SERVICE}.saved_query_workflow_exists", return_value=False),
            mock.patch.object(DataWarehouseSavedQuery, "setup_model_paths"),
        ):
            self.sq.schedule_materialization()
        sync_wf.assert_not_called()
        self.sq.refresh_from_db()
        assert self.sq.is_materialized is False
