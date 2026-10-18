import 'package:dio/dio.dart';
import 'package:http/http.dart' as http;

final dio = Dio(BaseOptions(baseUrl: "https://api.harbor.example/v2"));

Future<void> load(String id) async {
  await dio.get("/products/$id");
  await dio.post("/baskets/${basket.id}/items");
  await http.get(Uri.parse("https://cms.harbor.example/banners"));
  // await http.get(Uri.parse("https://old.harbor.example/x"));
}
