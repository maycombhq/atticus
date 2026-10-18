package harbor.shop.api

import retrofit2.http.*

interface CatalogApi {
    @GET("products/{id}")
    suspend fun product(@Path("id") id: String): Product

    @POST("baskets/{id}/items")
    suspend fun addItem(@Path("id") id: String, @Body item: Item): Basket

    @GET("/health")
    suspend fun health(): String
}
