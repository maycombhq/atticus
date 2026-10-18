package harbor.shop.api

object ApiModule {
    // .baseUrl("https://old.harbor.example/") was the v1 host
    val retrofit = Retrofit.Builder()
        .baseUrl("https://api.harbor.example/v2/")
        .build()
}
