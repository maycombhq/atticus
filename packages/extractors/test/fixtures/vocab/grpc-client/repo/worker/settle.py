import grpc
import ledger_pb2_grpc


def stub():
    channel = grpc.insecure_channel("ledger:50051")
    return ledger_pb2_grpc.LedgerServiceStub(channel)
